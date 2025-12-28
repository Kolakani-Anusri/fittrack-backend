// server.js
// FitTrack backend — FINAL STABLE VERSION (Node 22+ / Render safe)


import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import User from "./models/User.js";

import fs from "fs";
import pdf from "pdf-parse";
import multer from "multer";




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

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
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
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
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
// Registration Route

app.post("/register", async (req, res) => {
  try {
    const {
      name,
      age,
      height,
      weight,
      gender,
      mobile,
      email,
      password
    } = req.body;

    // ✅ Validation
    if (
      !name ||
      !age ||
      !height ||
      !weight ||
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

    // ✅ Check existing user (email OR mobile)
    const existingUser = await User.findOne({
      $or: [{ email }, { mobile }],
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "User already registered",
      });
    }

    // ✅ Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Create user
    const user = new User({
      name,
      age,
      height,
      weight,
      gender,
      mobile,
      email,
      password: hashedPassword,
    });

    await user.save();

    res.json({
      success: true,
      message: "Registration successful",
    });

  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({
      success: false,
      message: "Server error during registration",
    });
  }
});



// Login Route
app.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    const user = await User.findOne({ mobile });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ message: "Login success", user, token });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

/* ======================
   AI PDF EVALUATION
   ====================== */


app.post("/ai-evaluate-pdf", upload.single("report"), async (req, res) => {
  console.log("🔥 AI ROUTE VERSION = v3-rate-limit-fix");

  try {
    if (!openai) {
      return res.status(503).json({
        success: false,
        message: "AI disabled (OPENAI_API_KEY missing)",
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: "No report uploaded",
      });
    }

    const parsed = await pdfParse(req.file.buffer);

    if (!parsed.text || parsed.text.length < 150) {
      return res.json({
        success: false,
        message: "This report appears scanned or unreadable",
      });
    }

    // ----------------------------
    // USER META
    // ----------------------------
    let userMeta = {};
    try {
      userMeta = req.body.userMeta
        ? JSON.parse(req.body.userMeta)
        : {};
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid userMeta JSON",
      });
    }

    // ----------------------------
    // PROMPT
    // ----------------------------
    const prompt = `
You are a medical report analysis assistant.

Analyze the report and return ONLY valid JSON.

TASKS:
- Identify abnormal values
- Explain them simply
- Possible conditions (non-diagnostic)
- Diet & lifestyle suggestions
- Doctor specialty
- Further tests if needed

FORMAT (STRICT JSON):
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const raw = completion.choices[0].message.content;


    console.log("🔵 AI RAW RESPONSE:\n", raw);


    // ----------------------------
    // JSON EXTRACTION
    // ----------------------------
    let data;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON found");
      data = JSON.parse(match[0]);
    } catch {
      return res.json({
        success: false,
        message: "AI could not interpret this report",
      });
    }

    // ----------------------------
    // SUCCESS RESPONSE
    // ----------------------------
    return res.json({
      success: true,
      evaluation: data,
    });

  } 
  catch (err) {
    console.error("❌ AI ERROR RAW:", err);

    // FORCE HANDLE RATE LIMIT (ALL CASES)
    if (
      err?.code === "rate_limit_exceeded" ||
      err?.error?.code === "rate_limit_exceeded" ||
      String(err?.message || "").includes("rate limit")
    ) {
      return res.status(429).json({
        success: false,
        message: "AI busy. Please wait 60 seconds and retry.",
      });
    }

    // LAST RESORT — NEVER LIE WITH 500
    return res.status(200).json({
      success: false,
      message: "AI unavailable right now.",
    });
  }
});



// ================================
// AI: DIET & WORKOUT PLAN
// ================================

// simple server-side cooldown (1 request per minute)
let lastDietCallTime = 0;

app.post("/ai-diet-workout", async (req, res) => {
  console.log("🟢 /ai-diet-workout HIT");

  try {
    // Safety: OpenAI check
    if (!openai) {
      return res.status(503).json({
        success: false,
        message: "AI service unavailable",
      });
    }

    // ⏱️ Rate-limit (1 minute)
    const now = Date.now();
    if (now - lastDietCallTime < 60_000) {
      return res.status(429).json({
        success: false,
        message: "Please wait 1 minute before generating again",
      });
    }
    lastDietCallTime = now;

    const { age, gender, height, weight, bmi, preference } = req.body;

    // Basic validation
    if (!age || !gender || !height || !weight || !bmi) {
      return res.status(400).json({
        success: false,
        message: "Missing required user details",
      });
    }

    // 🎯 SHORT & SAFE PROMPT (very important)
    const prompt = `
Create a clear DIET PLAN and WORKOUT PLAN.

User:
Age: ${age}
Gender: ${gender}
Height: ${height} cm
Weight: ${weight} kg
BMI: ${bmi}
Food preference: ${preference}

Rules:
- Indian foods
- Simple meals
- Beginner friendly
- Home workouts only
- Bullet points only

Format exactly like this:

DIET PLAN:
<diet>

WORKOUT PLAN:
<workout>
`;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      max_output_tokens: 700,
      temperature: 0.5,
    });

    // 🧠 Safe extraction
    const text =
      response.output?.[0]?.content?.[0]?.text ||
      response.output_text;

    if (!text) {
      throw new Error("Empty AI response");
    }

    // Split sections
    const dietPlan = text
      .split("WORKOUT PLAN:")[0]
      .replace("DIET PLAN:", "")
      .trim();

    const workoutPlan =
      text.split("WORKOUT PLAN:")[1]?.trim() || "";

    return res.json({
      success: true,
      dietPlan,
      workoutPlan,
    });

  } catch (err) {
    console.error("❌ Diet AI error:", err);

    // Handle OpenAI rate limit properly
    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        message: "AI is busy. Please try again after a minute.",
      });
    }

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
