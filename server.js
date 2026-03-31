const express = require("express");
const multer = require("multer");
const mysql = require("mysql2");
const cron = require("node-cron");
const ffmpeg = require("fluent-ffmpeg");
const WebSocket = require("ws");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");

const app = express();
const PORT = 5000;

// ✅ Middleware
app.use(cors());
app.use(express.json()); 
app.use(bodyParser.urlencoded({ extended: true })); 

// ✅ MySQL Database Connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "RadioDNT123!",
  database: "radio_schedule"
});

db.connect(err => {
  if (err) {
    console.error("Database connection failed:", err);
  } else {
    console.log("✅ Connected to MySQL");
  }
});

// **🔹 Get All Schedules**
app.get("/schedule", (req, res) => {
  db.query("SELECT * FROM schedule ORDER BY scheduled_time ASC", (err, results) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json(results);
  });
});

// **🔹 Add a Schedule**
app.post("/addSchedule", (req, res) => {
  const { filename, scheduled_time } = req.body;
  if (!filename || !scheduled_time) return res.status(400).json({ error: "Missing filename or scheduled_time" });

  db.query(
    "INSERT INTO schedule (filename, scheduled_time, status) VALUES (?, ?, 'pending')",
    [filename, scheduled_time],
    (err, result) => {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json({ message: "✅ Schedule added!", id: result.insertId });
    }
  );
});

// **🔹 Delete a Schedule**
app.delete("/schedule/:id", (req, res) => {
  db.query("DELETE FROM schedule WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json({ message: "✅ Schedule deleted successfully!" });
  });
});

// **🔹 Process Scheduled Files**
const checkSchedule = () => {
  console.log("🔍 Checking schedule...");
  db.query(
    "SELECT * FROM schedule WHERE scheduled_time <= NOW() AND status = 'pending'",
    (err, results) => {
      if (err) return console.error("❌ Error fetching schedules:", err);

      results.forEach((row) => {
        const inputFile = path.join(__dirname, "uploads", row.filename);
        const outputFile = path.join(__dirname, "public", `${row.filename}.m3u8`);


        if (!fs.existsSync(inputFile)) {
          console.error(`❌ File ${row.filename} not found`);
          // Mark schedule as error in DB
          db.query("UPDATE schedule SET status = 'error' WHERE id = ?", [row.id], (err) => {
            if (err) console.error("❌ Error updating schedule status:", err);
            // Delete the schedule entry if file is missing
            db.query("DELETE FROM schedule WHERE id = ?", [row.id], (err2) => {
              if (err2) console.error("❌ Error deleting schedule entry:", err2);
              else console.log(`🗑️ Schedule entry for ${row.filename} deleted.`);
            });
          });
          return;
        }

        console.log(`⏳ Processing file: ${row.filename}`);
        db.query("UPDATE schedule SET status = 'processing' WHERE id = ?", [row.id]);

        ffmpeg(inputFile)
          .audioCodec("aac")
          .format("hls")
          .outputOptions(["-hls_time 10", "-hls_list_size 0", "-f hls"])
          .output(outputFile)
          .on("end", () => {
            console.log(`✅ Streaming started for ${row.filename}`);
            db.query("UPDATE schedule SET status = 'done' WHERE id = ?", [row.id]);

            // **🔹 Notify Frontend via WebSocket**
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ event: "new_stream", file: row.filename }));
              }
            });
          })
          .on("error", (err) => {
            console.error(`❌ FFmpeg Error: ${err}`);
            db.query("UPDATE schedule SET status = 'error' WHERE id = ?", [row.id]);
          })
          .run();
      });
    }
  );
};

// **🔹 Run `checkSchedule` Every Minute**
cron.schedule("* * * * *", checkSchedule);

// Ensure 'uploads' and 'public' folders exist
const uploadDir = path.join(__dirname, "uploads");
const publicDir = path.join(__dirname, "public");
const scheduleFile = path.join(__dirname, "schedule.json");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
// Function to read schedule
function getSchedule() {
  if (fs.existsSync(scheduleFile)) {
    return JSON.parse(fs.readFileSync(scheduleFile, "utf-8"));
  }
  return [];
}

// WebSocket Server
const wss = new WebSocket.Server({ port: 5001 });

wss.on("connection", (ws) => {
  console.log("Client connected");
});
wss.onmessage = (msg) => console.log("WebSocket Received:", msg.data);

// Configure multer to save the original filename
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Keep the original filename
  }
});

const upload = multer({ storage });

// Handle audio uploads & conversion
app.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  const originalFilename = path.parse(req.file.originalname).name; // Get filename without extension
  const inputFile = req.file.path; // Uploaded file path
  const outputFile = path.join(publicDir, `${originalFilename}.m3u8`); // Keep original filename but use .m3u8

  console.log(`Processing file: ${inputFile}`);

  // Notify frontend when upload starts
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ 
        status: "uploading", 
        file: req.file.originalname  // Correct filename
      }));
    }
  });

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

    // Notify frontend when FFmpeg is processing the file
    .on("progress", (progress) => {
      const percent = progress.percent ? Math.round(progress.percent) : 0;
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
            status: "processing", 
            progress: percent 
          }));
        }
      });
    })

    // Notify frontend when streaming is ready
    .on("end", () => {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
            status: "done", 
            playlist: `/public/${originalFilename}.m3u8`  // Send correct playlist URL
          }));
        }
      });

      // Notify WebSocket clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
            message: "new_audio_available", 
            playlist: `/public/${originalFilename}.m3u8`
          }));
        }
      });

      res.send({ message: "Streaming started", playlist: `/public/${originalFilename}.m3u8` });
    })

    .on("error", (err) => {
      console.error("FFmpeg Error:", err);
      res.status(500).send("Error processing audio.");
    })

    .run();  // ✅ Correct placement of .run()
});

// Serve static files
app.use("/public", express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    }
    if (filePath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Disposition", "inline");
    }
  }
}));

// Root route
app.get("/", (req, res) => {
  res.json({ 
    message: "Welcome to Radio DNT Server!",
    endpoints: {
      "GET /list": "View all available audio files",
      "POST /upload": "Upload new audio file",
      "GET /schedule": "View all schedules",
      "POST /addSchedule": "Add new schedule",
      "DELETE /schedule/:id": "Delete schedule",
      "DELETE /delete/:filename": "Delete audio file"
    }
  });
});

// List available music files
app.get("/list", (req, res) => {
  fs.readdir(publicDir, (err, files) => {
    if (err) {
      return res.status(500).json({ error: "Error reading files" });
    }

    // Filter only .m3u8 files
    const playlists = files.filter(file => file.endsWith(".m3u8"))
                           .map(file => ({ name: file, url: `/public/${file}` }));

    res.json(playlists);
  });
});

// DELETE route to remove files
app.delete("/delete/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(publicDir, filename);

  console.log("🔍 Attempting to delete file:", filename);
  console.log("📂 Full path:", filePath);

  if (!fs.existsSync(filePath)) {
    console.log("❌ File does not exist!");
    return res.status(404).json({ error: "File not found" });
  }

  try {
    fs.unlinkSync(filePath);
    console.log("✅ File deleted successfully!");
    res.json({ message: `${filename} deleted successfully` });
  } catch (error) {
    console.error("❌ Error deleting file:", error);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
