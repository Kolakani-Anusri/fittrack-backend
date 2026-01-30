// server.js
// FitTrack backend — FINAL CLEAN & STABLE VERSION (Node 22+ / Render safe)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import multer from "multer";
import User from "./models/User.js";

dotenv.config();

/* ======================
   APP INIT
   ====================== */
const app = express();

/* ======================
   CONFIG
   ====================== */
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "FITTRACK_FALLBACK_SECRET";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ======================
   OPENAI INIT
   ====================== */
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log("✅ OpenAI initialized");
} else {
  console.warn("⚠️ OPENAI_API_KEY missing — AI disabled");
}

/* ======================
   MIDDLEWARE
   ====================== */
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

/* ======================
   HEALTH CHECK
   ====================== */
app.get("/", (req, res) => {
  res.json({ message: "✅ FitTrack backend running" });
});

/* ======================
   FILE UPLOAD (PDF)
   ====================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.includes("pdf")) {
      cb(new Error("Only PDF files allowed"));
    } else {
      cb(null, true);
    }
  },
});

/* ======================
   DATABASE
   ====================== */
if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing");
  process.exit(1);
}

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB error:", err.message);
    process.exit(1);
  });

/* ======================
   AUTH ROUTES
   ====================== */

// REGISTER
app.post("/register", async (req, res) => {
  try {
    const { name, age, height, weight, gender, mobile, email, password } =
      req.body;

    if (
      !name ||
      age == null ||
      height == null ||
      weight == null ||
      !gender ||
      !mobile ||
      !email ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { mobile }],
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "User already registered",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await new User({
      name,
      age,
      height,
      weight,
      gender,
      mobile,
      email,
      password: hashedPassword,
    }).save();

    res.json({ success: true, message: "Registration successful" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// LOGIN
app.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    const user = await User.findOne({ mobile });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ message: "Login success", user, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

/* ======================
   AI PDF EVALUATION
   ====================== */
app.post("/ai-evaluate-pdf", upload.single("report"), async (req, res) => {
  try {
    if (!openai) {
      return res.json({ success: false, message: "AI disabled" });
    }

    if (!req.file?.buffer) {
      return res.json({ success: false, message: "No report uploaded" });
    }

    const parsed = await pdfParse(req.file.buffer);
    if (!parsed.text || parsed.text.length < 150) {
      return res.json({
        success: false,
        message: "Report unreadable or scanned",
      });
    }

    let userMeta = {};
    try {
      userMeta = req.body.userMeta ? JSON.parse(req.body.userMeta) : {};
    } catch {
      return res.json({ success: false, message: "Invalid userMeta JSON" });
    }

    const prompt = `
Return ONLY valid JSON.

{
  "overview": "",
  "evaluation": "",
  "diet": "",
  "doctors": [],
  "furtherDiagnosis": [],
  "limitations": ""
}

Patient Info:
${JSON.stringify(userMeta, null, 2)}

Report Text:
${parsed.text.slice(0, 3500)}
`;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 600,
    });

    let text = "";
    for (const item of response.output || []) {
      for (const block of item.content || []) {
        if (block.type === "output_text") text += block.text;
      }
    }

    let data;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      data = JSON.parse(match[0]);
    } catch {
      return res.json({ success: false, message: "AI parse failed" });
    }

    res.json({ success: true, evaluation: data });
  } catch (err) {
    console.error("PDF AI error:", err);
    res.json({ success: false, message: "AI failed" });
  }
});


// ================================
// AI: WEEKLY DIET & WEEKLY WORKOUT
// ================================

const dietCooldownMap = new Map();

app.post("/ai-diet-workout", async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({
        success: false,
        message: "AI service unavailable",
      });
    }

    // Cooldown (1 minute)
    const userKey =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress;

    const now = Date.now();
    if (now - (dietCooldownMap.get(userKey) || 0) < 60_000) {
      return res.status(429).json({
        success: false,
        message: "Please wait 1 minute before generating again",
      });
    }

    const { age, gender, height, weight, bmi, preference } = req.body;

    if (
      age == null ||
      !gender ||
      height == null ||
      weight == null ||
      bmi == null
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required user details",
      });
    }

    // 🔥 STRICT WEEKLY PROMPT
    const prompt = `
    You are a fitness and nutrition expert.

    STRICT RULES:
    - Return ONLY valid JSON
    - NO markdown
    - NO bullet points
    - NO plain text
    - NO explanations
    - NO arrays
    - Use EXACT keys and structure

    FORMAT (MUST MATCH EXACTLY):

    {
      "dietPlan": {
        "Sunday": {
          "breakfast": "",
          "juice": "",
          "lunch": "",
          "snack": "",
          "dinner": ""
        },
        "Monday": {
          "breakfast": "",
          "juice": "",
          "lunch": "",
          "snack": "",
          "dinner": ""
        },
        "Tuesday": {
          "breakfast": "",
          "juice": "",
          "lunch": "",
          "snack": "",
          "dinner": ""
        },
        "Wednesday": {
          "breakfast": "",
          "juice": "",
          "lunch": "",
          "snack": "",
          "dinner": ""
        },
        "Thursday": {
          "breakfast": "",
          "juice": "",
          "lunch": "",
          "snack": "",
          "dinner": ""
        },
        "Friday": {
          "breakfast": "",
          "juice": "",
          "lunch": "",
          "snack": "",
          "dinner": ""
        },
        "Saturday": {
          "breakfast": "",
          "juice": "",
          "lunch": "",
          "snack": "",
          "dinner": ""
        }
      },

      "workoutPlan": {
        "Sunday": {
          "warmup": "",
          "mainWorkout": "",
          "cooldown": ""
        },
        "Monday": {
          "warmup": "",
          "mainWorkout": "",
          "cooldown": ""
        },
        "Tuesday": {
          "warmup": "",
          "mainWorkout": "",
          "cooldown": ""
        },
        "Wednesday": {
          "warmup": "",
          "mainWorkout": "",
          "cooldown": ""
        },
        "Thursday": {
          "warmup": "",
          "mainWorkout": "",
          "cooldown": ""
        },
        "Friday": {
          "warmup": "",
          "mainWorkout": "",
          "cooldown": ""
        },
        "Saturday": {
          "warmup": "",
          "mainWorkout": "",
          "cooldown": ""
        }
      }
    }

    User details:
    Age: ${age}
    Gender: ${gender}
    Height: ${height}
    Weight: ${weight}
    BMI: ${bmi}
    Food preference: ${preference}

    Rules:
    - Indian food only
    - Beginner-safe workouts
    - Clear exercises in each field
    `;


    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      temperature: 0.4,
      max_output_tokens: 900,
    });

    // Extract AI text
    let text = "";
    for (const item of response.output || []) {
      for (const block of item.content || []) {
        if (block.type === "output_text") {
          text += block.text;
        }
      }
    }

    if (!text.trim()) throw new Error("Empty AI response");

    // Parse JSON
    let data;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      data = JSON.parse(match[0]);
    } catch {
      return res.json({
        success: false,
        message: "AI returned invalid format. Please retry.",
      });
    }

    // Validate exactly 7 days
    const days = [
      "Sunday","Monday","Tuesday",
      "Wednesday","Thursday","Friday","Saturday"
    ];

    for (const day of days) {
      if (!data.dietPlan?.[day] || !data.workoutPlan?.[day]) {
        return res.json({
          success: false,
          message: "AI response incomplete. Please retry.",
        });
      }
    }

    dietCooldownMap.set(userKey, now);

    return res.json({
      success: true,
      dietPlan: data.dietPlan,
      workoutPlan: data.workoutPlan,
    });

  } catch (err) {
    console.error("❌ Weekly plan AI error:", err);
    return res.status(500).json({
      success: false,
      message: "AI failed to generate plan",
    });
  }
});




/* ======================
   START SERVER
   ====================== */
app.listen(PORT, () => {
  console.log(`🚀 FitTrack backend running on port ${PORT}`);
});
