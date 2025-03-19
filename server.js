const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const WebSocket = require("ws");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 5000;
app.use(cors());

// Ensure 'uploads' and 'public' folders exist
const uploadDir = path.join(__dirname, "uploads");
const publicDir = path.join(__dirname, "public");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

// WebSocket Server
const wss = new WebSocket.Server({ port: 5001 });

wss.on("connection", (ws) => {
  console.log("Client connected");
});

// Configure multer for audio uploads (store in memory first)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Handle audio uploads & conversion
app.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  const timestamp = Date.now();
  const inputFile = path.join(uploadDir, `audio_${timestamp}.wav`);
  const outputFile = path.join(publicDir, `output_${timestamp}.m3u8`);

  // Write uploaded file to disk
  fs.writeFileSync(inputFile, req.file.buffer);

  console.log(`Processing file: ${inputFile}`);

  // Convert audio to HLS using FFmpeg
  ffmpeg(inputFile)
    .audioCodec("aac")
    .format("hls")
    .outputOptions([
      "-hls_time 10", // Segment duration (10 seconds)
      "-hls_list_size 0", // Keep all segments
      "-hls_flags delete_segments", // Remove old segments
      "-f hls",
    ])
    .output(outputFile)
    .on("end", () => {
      console.log(`Streaming started: ${outputFile}`);

      // Notify WebSocket clients after conversion completes
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
            message: "new_audio_available", 
            playlist: `/public/output_${timestamp}.m3u8`
          }));
        }
      });

      res.send({ message: "Streaming started", playlist: `/public/output_${timestamp}.m3u8` });
    })
    .on("error", (err) => {
      console.error("FFmpeg Error:", err);
      res.status(500).send("Error processing audio.");
    })
    .run();
});

// Serve static files with correct headers
app.use("/public", express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    }
    if (filePath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "no-cache");  // Ensure fresh requests
      res.setHeader("Content-Disposition", "inline"); // Force inline streaming
    }
  }
}));

// Root Route
app.get("/", (req, res) => {
  res.send("Welcome to the Live Audio Streaming Server! Use the /upload endpoint to upload audio files.");
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
