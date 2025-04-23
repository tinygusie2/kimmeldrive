#!/bin/bash

CONFIG_FILE=".env"
FLAG_FILE=".setup_complete" # Hidden file to mark setup completion

echo "--- File Server Setup ---"

# Check if setup might have been done (config file exists)
if [ -f "$CONFIG_FILE" ]; then
  echo "Configuration file ($CONFIG_FILE) already exists."
  read -p "Do you want to re-run setup and overwrite it? (y/N): " RECONFIRM
  # Default to No if user just presses Enter
  if [[ ! "$RECONFIRM" =~ ^[Yy]$ ]]; then
    echo "Setup cancelled. Using existing configuration."
    # Ensure the flag file exists if config exists but flag was somehow deleted
    touch "$FLAG_FILE"
    exit 0 # Exit successfully, indicating setup is considered complete
  fi
fi

# Prompt for storage path
STORAGE_PATH=""
while [ -z "$STORAGE_PATH" ]; do
  # Use -e to allow backspace etc.
  read -e -p "Enter the full path for the storage directory: " INPUT_PATH
  # Basic check: is it empty? Could add more checks (e.g., using realpath)
  if [ -z "$INPUT_PATH" ]; then
    echo "Path cannot be empty. Please try again."
  else
    # Simple assignment for now. Realpath could resolve relative paths if needed.
    # STORAGE_PATH=$(realpath "$INPUT_PATH") # Optional: Resolve to absolute path
    STORAGE_PATH="$INPUT_PATH"
  fi
done

# Create the .env configuration file
echo "# Configuration for Node File Server" > "$CONFIG_FILE"
# Make sure to quote the path in case it contains spaces or special characters
echo "STORAGE_PATH=\"$STORAGE_PATH\"" >> "$CONFIG_FILE"

echo ""
echo "Configuration saved to $CONFIG_FILE:"
cat "$CONFIG_FILE"
echo ""
echo "Setup complete. The server will now start."
echo "If you need to change the path later, you can:"
echo " 1. Delete the '$FLAG_FILE' file"
echo " 2. Run 'npm start' again"
echo "OR"
echo " 1. Manually edit the '$CONFIG_FILE' file."
echo ""

# Important: Exit with success code 0 so the npm script knows setup finished correctly
exit 0