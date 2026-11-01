const fs = require("fs");

/**
 * Write a file via temp-file + rename so a concurrent reader (or a crash
 * mid-write) never leaves a truncated config behind. On failure the temp file
 * is removed and the target is untouched.
 */
function writeFileAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

module.exports = { writeFileAtomic };
