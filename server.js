// Add dotenv configuration at the very top
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs-extra'); // Use fs-extra for convenience
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const cors = require('cors');

// --- Configuration ---
const PORT = process.env.PORT || 5000;
const SHARE_DURATION_HOURS = 1; // Share expiry time

// --- Get Storage Path from Environment Variable ---
const UPLOAD_FOLDER_ROOT = process.env.STORAGE_PATH; // Read from .env file

if (!UPLOAD_FOLDER_ROOT) {
    console.error("\nFATAL ERROR: STORAGE_PATH is not defined in the .env file.");
    console.error("Setup might be incomplete or the .env file is missing/corrupted.");
    console.error("Try running setup again by deleting the '.setup_complete' file and running 'npm start'.");
    process.exit(1); // Exit if path is missing
}

// Resolve the path once at the start for consistency
const RESOLVED_UPLOAD_FOLDER_ROOT = path.resolve(UPLOAD_FOLDER_ROOT);
console.log(`Using storage root path: ${RESOLVED_UPLOAD_FOLDER_ROOT}`);

// --- Ensure the root upload folder exists ---
try {
    fs.ensureDirSync(RESOLVED_UPLOAD_FOLDER_ROOT);
    console.log(`Storage root directory ensured at: ${RESOLVED_UPLOAD_FOLDER_ROOT}`);
} catch (err) {
    console.error(`\nFATAL ERROR: Could not create or access the specified storage directory.`);
    console.error(`Path: "${RESOLVED_UPLOAD_FOLDER_ROOT}"`);
    console.error("Please check permissions and ensure the path is valid.");
    console.error("\nUnderlying Error Details:", err);
    process.exit(1);
}

// --- Initialize Express App ---
const app = express();

// --- In-Memory Storage for Share Links ---
// WARNING: Lost on server restart! Use a file or DB for persistence.
let shareLinks = {}; // { "share_id": { path: "relative/path/file.txt", created_at: Date_object } }

// --- Middleware ---
app.use(cors());
app.use(express.json()); // Parse JSON request bodies up to default limit
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies
// Serve static files (index.html) from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Helper Function for Path Safety ---
function getSafePath(relativePathSuffix = '') {
    try {
        const decodedSuffix = decodeURIComponent(relativePathSuffix);
        // Resolve relative to the already resolved root path
        const absoluteTargetPath = path.resolve(RESOLVED_UPLOAD_FOLDER_ROOT, decodedSuffix);

        // Security Check: Ensure the resolved path is still within the root folder
        // Handle edge case where the path *is* the root folder correctly
        if (!absoluteTargetPath.startsWith(RESOLVED_UPLOAD_FOLDER_ROOT + path.sep) && absoluteTargetPath !== RESOLVED_UPLOAD_FOLDER_ROOT) {
             console.warn(`UNSAFE PATH DETECTED: ${relativePathSuffix} -> ${absoluteTargetPath} (Base: ${RESOLVED_UPLOAD_FOLDER_ROOT})`);
             return null; // Indicate unsafe path
         }
        return absoluteTargetPath;
    } catch (e) {
        // Catch potential decoding errors
        console.error(`Error resolving path for suffix "${relativePathSuffix}":`, e);
        return null;
    }
}


// --- Multer Configuration for File Uploads ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const subpath = req.params.subpath || '';
        const targetDir = getSafePath(subpath); // Validate and resolve path

        if (!targetDir) {
             console.error(`Multer destination error: Invalid safe path for subpath "${subpath}"`);
             return cb(new Error('Invalid upload directory specified (path safety check failed)'), null);
        }
        // Use ensureDir to handle creation robustly
        fs.ensureDir(targetDir, err => {
            if (err) {
                console.error(`Multer failed to ensure directory ${targetDir}:`, err);
                return cb(new Error(`Failed to create target directory: ${err.message}`), null);
            }
            // console.log(`Multer ensured destination directory: ${targetDir}`); // Optional logging
            cb(null, targetDir); // Set the destination directory
        });
    },
    filename: function (req, file, cb) {
        // Use the original filename, but sanitize it slightly (basic)
        const safeName = file.originalname.replace(/[/\\?%*:|"<>]/g, '_'); // Remove illegal chars
        const parentDir = getSafePath(req.params.subpath || '');
        if (!parentDir) { return cb(new Error("Cannot determine safe parent directory for filename check")); }

        const potentialPath = path.join(parentDir, safeName);

        // Basic collision avoidance: Check if file exists, add timestamp if it does
        fs.pathExists(potentialPath, (err, exists) => {
            if (err) { console.error("Error checking file existence:", err); return cb(err); }
            if (exists) {
                const timestamp = Date.now();
                const ext = path.extname(safeName);
                const base = path.basename(safeName, ext);
                const newName = `${base}_${timestamp}${ext}`;
                console.warn(`Filename collision: Renaming "${safeName}" to "${newName}"`);
                cb(null, newName);
            } else {
                cb(null, safeName);
            }
        });
    }
});

const upload = multer({
    storage: storage,
    // limits: { fileSize: 500 * 1024 * 1024 }, // Optional: 500 MB limit
});


// --- API Routes ---

// Browse files and folders
app.get('/api/browse/:subpath(*)?', async (req, res) => {
    const subpath = req.params.subpath || '';
    const currentPath = getSafePath(subpath);

    if (!currentPath || !await fs.pathExists(currentPath)) {
         // Handle case where path doesn't exist (might happen after delete/move)
         return res.status(404).json({ error: "Path not found", path: subpath });
    }
    if(!(await fs.stat(currentPath)).isDirectory()){
        return res.status(400).json({ error: "Path is not a directory", path: subpath });
    }


    try {
        const dirents = await fs.readdir(currentPath, { withFileTypes: true });
        const items = dirents.map(dirent => {
            const itemName = dirent.name;
            // Construct relative path for frontend links, ensure forward slashes
            const itemRelativePath = path.join(subpath, itemName).replace(/\\/g, '/');
            return {
                name: itemName,
                is_dir: dirent.isDirectory(),
                path: itemRelativePath
            };
        });

        // Sort folders first, then files, alphabetically (case-insensitive)
        items.sort((a, b) => {
            if (a.is_dir !== b.is_dir) {
                return a.is_dir ? -1 : 1; // Directories first
            }
            // LocaleCompare for proper sorting of names
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        // Calculate parent path (relative)
        let parentPath = null;
        if (subpath) {
            parentPath = path.dirname(subpath).replace(/\\/g, '/');
            if (parentPath === '.') parentPath = ''; // Root represented by empty string
        }

        res.json({
            current_path: subpath,
            parent_path: parentPath,
            items: items
        });
    } catch (error) {
        console.error(`Error listing directory ${currentPath}:`, error);
        res.status(500).json({ error: "Error listing files", details: error.message });
    }
});

// Upload a file (uses multer middleware defined earlier)
app.post('/api/upload/:subpath(*)?', upload.single('file'), (req, res) => {
    // Multer handles the saving. We just respond.
    if (!req.file) {
        // This might happen if the destination callback in multer failed or filter rejected
        return res.status(400).json({ error: "File upload failed or was rejected." });
    }
    const subpath = req.params.subpath || '';
    console.log(`File uploaded: ${req.file.filename} to /${subpath}`);
    res.json({ message: `File "${req.file.filename}" uploaded successfully to /${subpath}` });
}, (error, req, res, next) => {
    // Express error handler specifically for multer errors
    console.error("Upload error:", error);
    res.status(400).json({ error: `Upload failed: ${error.message}` });
});


// Download a file (Also used for previewing/editing text content)
app.get('/download/:filepath(*)', async (req, res) => {
    const filepath = req.params.filepath;
    const safeFullPath = getSafePath(filepath);

    if (!safeFullPath) {
        return res.status(400).send("Invalid file path.");
    }

    try {
        // Check existence before stating
        if (!await fs.pathExists(safeFullPath)) {
             return res.status(404).send("File not found.");
        }
        const stats = await fs.stat(safeFullPath);
        if (!stats.isFile()) {
            return res.status(400).send("Path is not a file."); // Use 400 Bad Request for type mismatch
        }

        const filename = path.basename(safeFullPath);
        console.log(`Attempting download/access: ${filename} from ${safeFullPath}`);

        // Use res.download for explicit download prompts
        // For previews (like text), the browser's fetch might just get the content directly
        // We can add 'Accept' header check later if needed to differentiate intent.
        res.download(safeFullPath, filename, (err) => {
            if (err) {
                // Handle specific errors if possible (e.g., permission denied)
                console.error(`Error sending file ${filename}:`, err);
                // Avoid sending another response if headers already sent
                if (!res.headersSent) {
                    res.status(500).send("Error occurred during file download.");
                }
            } else {
                console.log(`File sent: ${filename}`);
            }
        });
    } catch (error) {
        // Handle errors like file not found during stat (should be caught by pathExists now)
        console.error(`Error accessing file ${safeFullPath}:`, error);
        res.status(500).send("Server error accessing file.");
    }
});

// Create a directory
app.post('/api/mkdir', async (req, res) => {
    const { parent_path, dir_name } = req.body;

    if (!dir_name) {
        return res.status(400).json({ error: "Directory name is required." });
    }
    // Basic sanitization for directory name
    const safeDirName = dir_name.replace(/[/\\?%*:|"<>]/g, '_').replace(/^\.+$/, '_'); // Avoid '.' or '..' and illegal chars
    if (!safeDirName || safeDirName === '.' || safeDirName === '..') {
        return res.status(400).json({ error: "Invalid directory name provided."});
    }

    const parentDir = getSafePath(parent_path || ''); // Default to root if not specified
    if (!parentDir || !await fs.pathExists(parentDir) || !(await fs.stat(parentDir)).isDirectory()) {
        return res.status(400).json({ error: "Invalid or non-existent parent path." });
    }

    const newDirPath = path.join(parentDir, safeDirName);

    try {
        if (await fs.pathExists(newDirPath)) {
            return res.status(409).json({ error: `Directory or file '${safeDirName}' already exists.` }); // 409 Conflict
        }
        await fs.ensureDir(newDirPath); // fs-extra creates directory
        console.log(`Directory created: ${newDirPath}`);
        res.json({ message: `Directory '${safeDirName}' created successfully in /${parent_path || ''}` });
    } catch (error) {
        console.error(`Error creating directory ${newDirPath}:`, error);
        res.status(500).json({ error: "Could not create directory", details: error.message });
    }
});

// Delete a file or directory
app.post('/api/delete', async (req, res) => {
    const { path: itemPathSuffix } = req.body;
    if (!itemPathSuffix) {
        return res.status(400).json({ error: "Missing 'path' in request" });
    }

    const itemFullPath = getSafePath(itemPathSuffix);

    // Extra safety: Prevent deleting the root itself
    if (itemFullPath === RESOLVED_UPLOAD_FOLDER_ROOT) {
        console.warn(`Attempt to delete root folder blocked: ${itemFullPath}`);
        return res.status(403).json({ error: "Cannot delete the root storage directory" });
    }

    if (!itemFullPath) {
        return res.status(400).json({ error: "Invalid path specified." });
    }

    try {
        // Check existence before trying to remove
        if (!await fs.pathExists(itemFullPath)) {
            return res.status(404).json({ error: "Item not found." });
        }

        const itemName = path.basename(itemFullPath);
        // fs-extra remove handles both files and directories recursively
        await fs.remove(itemFullPath);
        console.log(`Item deleted: ${itemFullPath}`);
        res.json({ message: `Item '${itemName}' deleted successfully` });

    } catch (error) {
        console.error(`Error deleting item ${itemFullPath}:`, error);
        res.status(500).json({ error: "Could not delete item", details: error.message });
    }
});


// --- Sharing Routes ---

// Create a share link
app.post('/api/share', async (req, res) => {
    const { path: filePathSuffix } = req.body;
    if (!filePathSuffix) {
         return res.status(400).json({ error: "Missing 'path' in request" });
    }

    const fileFullPath = getSafePath(filePathSuffix);

    if (!fileFullPath) {
        return res.status(400).json({ error: "Invalid file path." });
    }

    try {
        if (!await fs.pathExists(fileFullPath)) {
            return res.status(404).json({ error: "File not found for sharing." });
        }
        const stats = await fs.stat(fileFullPath);
        if (!stats.isFile()) {
            return res.status(400).json({ error: "Sharing is only supported for files." });
        }

        // Generate ID and store with timestamp
        const shareId = uuidv4();
        const creationTime = new Date(); // Current time (local timezone of server)

        shareLinks[shareId] = {
            path: filePathSuffix, // Store relative path
            created_at: creationTime
        };
        console.log(`Created share link: ${shareId} -> ${filePathSuffix} at ${creationTime.toISOString()}`);

        // Construct full URL using request headers
        const shareUrl = `${req.protocol}://${req.get('host')}/share/${shareId}`;

        // Generate QR Code Data URL
        let qrCodeDataUrl = null;
        try {
            qrCodeDataUrl = await QRCode.toDataURL(shareUrl);
        } catch (qrErr) {
            console.error(`Error generating QR code for ${shareId}:`, qrErr);
            // Proceed without QR code if generation fails
        }

        res.json({
            share_id: shareId,
            share_url: shareUrl,
            qr_code_data_url: qrCodeDataUrl
        });

    } catch (error) {
         // Catch stat errors too
         console.error(`Error accessing file for sharing ${fileFullPath}:`, error);
         res.status(500).json({ error: "Server error processing share request." });
    }
});

// Access a shared file
app.get('/share/:shareId', async (req, res) => {
    const { shareId } = req.params;

    const shareInfo = shareLinks[shareId]; // Get potential link info

    if (!shareInfo) {
        console.log(`Share ID not found: ${shareId}`);
        // Check potentially expired links (simple cleanup)
        // A more robust cleanup would run periodically
        Object.keys(shareLinks).forEach(id => {
            const link = shareLinks[id];
            const expiryTime = new Date(link.created_at.getTime() + SHARE_DURATION_HOURS * 60 * 60 * 1000);
            if (new Date() > expiryTime) {
                console.log(`Cleaning up expired link during lookup: ${id}`);
                delete shareLinks[id];
            }
        });
        return res.status(404).send("Share link is invalid or has expired.");
    }

    const creationTime = shareInfo.created_at;
    const filePathSuffix = shareInfo.path;

    // Check expiry
    const now = new Date();
    const expiryTime = new Date(creationTime.getTime() + SHARE_DURATION_HOURS * 60 * 60 * 1000);

    if (now > expiryTime) {
        console.log(`Share link expired: ${shareId} (Created: ${creationTime.toISOString()}, Expired: ${expiryTime.toISOString()})`);
        // Clean up the expired link
        delete shareLinks[shareId];
        return res.status(410).send(`Share link has expired (valid for ${SHARE_DURATION_HOURS} hour(s)).`); // 410 Gone
    }

    // Link is valid, try to serve the file
    const safeFullPath = getSafePath(filePathSuffix);

    if (!safeFullPath) {
         // Maybe path became invalid somehow?
         console.error(`Invalid path derived from valid share link ID ${shareId}: ${filePathSuffix}`);
         delete shareLinks[shareId]; // Clean up broken link
         return res.status(404).send("Shared file path is invalid.");
    }

    try {
        // Check existence and type before sending
        if (!await fs.pathExists(safeFullPath)) {
             console.warn(`Shared file path does not exist: ${safeFullPath} (ID: ${shareId})`);
             delete shareLinks[shareId];
             return res.status(404).send("The shared file is no longer available.");
        }
        const stats = await fs.stat(safeFullPath);
        if (!stats.isFile()) {
             console.warn(`Shared path is not a file: ${safeFullPath} (ID: ${shareId})`);
             delete shareLinks[shareId];
             return res.status(404).send("The shared item is not a file.");
        }

        const filename = path.basename(safeFullPath);
        console.log(`Serving shared file: ${filename} (ID: ${shareId})`);
        res.download(safeFullPath, filename, (err) => {
             if (err) {
                console.error(`Error sending shared file ${filename}:`, err);
                if (!res.headersSent) {
                    res.status(500).send("Error downloading shared file.");
                }
            } else {
                console.log(`Shared file sent: ${filename}`);
            }
        });

    } catch (error) {
        console.error(`Error accessing shared file ${safeFullPath}:`, error);
        res.status(500).send("Server error accessing shared file.");
    }
});

// --- NEW API Endpoint: Move File/Folder ---
app.post('/api/move', async (req, res) => {
    const { sourcePath: sourceSuffix, destinationPath: destinationSuffix } = req.body;

    if (!sourceSuffix || destinationSuffix === undefined) { // Allow empty destination for root
        return res.status(400).json({ error: "Missing source or destination path" });
    }

    const sourceFullPath = getSafePath(sourceSuffix);
    // Destination is a *directory* where the item should be moved *into*.
    const destinationDirFullPath = getSafePath(destinationSuffix);

    if (!sourceFullPath || !destinationDirFullPath) {
        return res.status(400).json({ error: "Invalid source or destination path (safety check failed)" });
    }

    // Safety check: Ensure source exists
    if (!await fs.pathExists(sourceFullPath)) {
        return res.status(404).json({ error: `Source item not found: ${sourceSuffix}` });
    }

    // Safety check: Ensure destination is an existing directory
    try {
        // Check existence first
        if (!await fs.pathExists(destinationDirFullPath)) {
            return res.status(404).json({ error: `Destination directory not found: ${destinationSuffix}` });
        }
        const destStat = await fs.stat(destinationDirFullPath);
        if (!destStat.isDirectory()) {
            return res.status(400).json({ error: `Destination is not a directory: ${destinationSuffix}` });
        }
    } catch (error) {
         console.error(`Error stating destination directory ${destinationDirFullPath}:`, error);
         return res.status(500).json({ error: "Error checking destination directory" });
    }

    const itemName = path.basename(sourceFullPath);
    const finalDestinationPath = path.join(destinationDirFullPath, itemName);

    // Safety check: Prevent moving item onto itself or into itself
    if (sourceFullPath === finalDestinationPath || sourceFullPath === destinationDirFullPath) {
        return res.status(400).json({ error: "Cannot move item to the same location or into itself" });
    }
    // Prevent moving a folder into one of its own subfolders
    if ((await fs.stat(sourceFullPath)).isDirectory() && finalDestinationPath.startsWith(sourceFullPath + path.sep)) {
         return res.status(400).json({ error: "Cannot move a folder into itself or one of its subdirectories." });
    }


    // Safety check: Prevent overwriting existing file/folder at destination
    if (await fs.pathExists(finalDestinationPath)) {
         return res.status(409).json({ error: `An item named '${itemName}' already exists in the destination.` }); // 409 Conflict
    }

    try {
        console.log(`Moving "${sourceFullPath}" to "${finalDestinationPath}"`);
        await fs.move(sourceFullPath, finalDestinationPath); // fs-extra move handles files and dirs
        res.json({ message: `Successfully moved '${itemName}' to /${destinationSuffix || ''}` });
    } catch (error) {
        console.error(`Error moving item from ${sourceFullPath} to ${finalDestinationPath}:`, error);
        // Provide more specific error messages if possible (e.g., permission denied)
        res.status(500).json({ error: `Failed to move item: ${error.message}` });
    }
});

// --- NEW API Endpoint: Save File Content ---
app.post('/api/save', async (req, res) => {
    const { filePath: fileSuffix, content } = req.body;

    if (!fileSuffix || content === undefined || content === null) { // Check content existence
        return res.status(400).json({ error: "Missing file path or content" });
    }

    const fileFullPath = getSafePath(fileSuffix);

    if (!fileFullPath) {
        return res.status(400).json({ error: "Invalid file path (safety check failed)" });
    }

    // Check if it exists and is a file before writing
    try {
         if (!await fs.pathExists(fileFullPath)) {
            return res.status(404).json({ error: `File not found: ${fileSuffix}` });
        }
        const stat = await fs.stat(fileFullPath);
        if (!stat.isFile()) {
            return res.status(400).json({ error: "Target path is not a file." });
        }
    } catch (error) {
         console.error(`Error stating file for saving ${fileFullPath}:`, error);
         return res.status(500).json({ error: "Error checking file before save" });
    }

    try {
        console.log(`Saving content to "${fileFullPath}"`);
        // Overwrite the file with new content (defaulting to UTF-8)
        await fs.writeFile(fileFullPath, content, 'utf8'); // Explicitly UTF-8
        res.json({ message: `File '${path.basename(fileFullPath)}' saved successfully.` });
    } catch (error) {
        console.error(`Error writing file ${fileFullPath}:`, error);
        res.status(500).json({ error: `Failed to save file: ${error.message}` });
    }
});


// --- Start Server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n--- Node.js File Server Ready ---`);
    // Logged Storage Root and ensured dir earlier
    console.log(`Share Link Duration: ${SHARE_DURATION_HOURS} hour(s)`);
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    console.log(`Access UI via http://<your_local_ip>:${PORT}`);
    console.log(`\nWARNINGS:`);
    console.log(`  - No user authentication implemented!`);
    console.log(`  - File deletion is permanent!`);
    console.log(`  - Share links & timestamps are stored in memory (reset on server restart)!`);
    console.log("\nPress CTRL+C to stop.");
});