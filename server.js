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


/* ======================
   OPENAI CLIENT
   ====================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
} else {
  console.warn("⚠️ OPENAI_API_KEY not set — AI disabled");
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
app.post("/register", async (req, res) => {
  try {
    const { name, age, height, weight, gender, email } = req.body;

    if (!name || !age || !height || !weight || !gender || !email) {
      return res.status(400).json({
        success: false,
        message: "All fields including email are required",
      });
    }

    // Check existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "User already registered with this email",
      });
    }

    const user = new User({
      name,
      age,
      height,
      weight,
      gender,
      email,
    });

    await user.save();

    res.json({
      success: true,
      message: "Registration successful",
      user,
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
  console.log("🟢 /ai-evaluate-pdf hit");

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

    return res.json({
      success: true,
      evaluation: data,
    });

  } catch (err) {
    console.error("❌ AI ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "AI evaluation failed",
    });
  }
});



// ===============================
// AI DIET & WORKOUT ROUTE (FINAL)
// ===============================
app.post("/ai-diet-workout", async (req, res) => {
  try {
    const {
      age,
      gender,
      height,
      weight,
      bmi,
      preference,
      healthIssues = []
    } = req.body;

    if (!age || !gender || !height || !weight || !bmi || !preference) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    
    // -------------------------------
    // BMI BASED GOAL
    // -------------------------------
    let fitnessGoal = "maintenance";
    if (bmi >= 25) fitnessGoal = "weight_loss";
    else if (bmi < 18.5) fitnessGoal = "weight_gain";


    // 🚫 STRICT VEGAN BLOCK LIST
    const veganForbidden = [
      "milk", "curd", "paneer", "cheese", "butter", "ghee",
      "yogurt", "cream", "egg", "eggs", "chicken", "fish",
      "mutton", "meat", "honey", ""
    ];

    const isVegan = preference.toLowerCase() === "vegan";



    const prompt = `
    You are an AI fitness trainer and clinical nutritionist.

    STRICT RULE:
    Return ONLY valid JSON. No explanations, no markdown.

    USER PROFILE:
    Age: ${age}
    Gender: ${gender}
    Height: ${height} cm
    Weight: ${weight} kg
    BMI: ${bmi}
    Food Preference: ${preference}
    Health Issues: ${healthIssues.join(", ") || "None"}

    DECISION LOGIC (MANDATORY):
    1. Determine FITNESS GOAL using BMI:
      - BMI < 18.5 → Weight Gain
      - BMI 18.5–24.9 → Weight Maintenance
      - BMI ≥ 25 → Weight Loss

    2. Modify BOTH diet and workout based on:
      - Gender (safety, intensity)
      - Health Issues (PCOS, Thyroid, Diabetes, Anemia, etc.)

    3. Health issues take PRIORITY over BMI goals.

    DIET RULES:
    - Follow food preference strictly.
    - Vegan → NO milk, curd, paneer, butter, ghee, eggs, meat.
    - Indian foods only.
    - Mention WHY each food is chosen (nutrients, health benefit).
    - Include meal timing ONLY in column headers (not inside food text).

    WORKOUT RULES:
    - Separate workouts for Weight Loss / Gain / Maintenance.
    - Adjust intensity by gender.
    - Avoid unsafe exercises for health issues.
    - Include purpose of workout.

    OUTPUT JSON FORMAT (STRICT):

    {
      "fitnessGoal": "Weight Loss | Weight Gain | Maintenance",
      "healthFocus": ["PCOS", "Thyroid", "None"],

      "weeklyDiet": {
        "Sunday": {
          "breakfast": "Food (reason)",
          "juice": "Drink (reason)",
          "lunch": "Meal (reason)",
          "snack": "Snack (reason)",
          "dinner": "Dinner (reason)"
        }
      },

      "weeklyWorkout": {
        "Sunday": {
          "goalType": "Weight Loss | Weight Gain | Maintenance",
          "activity": "Workout name",
          "duration": "Time",
          "intensity": "Low | Moderate | High",
          "notes": "Why this workout is suitable"
        }
      },

      "confidence": "HIGH"
    }
    `;


    // 🤖 AI CALL
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt
    });

    const raw = response.output_text;
    console.log("🔵 AI RAW RESPONSE:\n", raw);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ message: "AI returned invalid JSON" });
    }

    // ===============================
    // 🧹 FINAL VEGAN SANITIZER (SERVER-SIDE)
    // ===============================
    if (isVegan && parsed.weeklyDiet) {
      for (const day in parsed.weeklyDiet) {
        for (const meal in parsed.weeklyDiet[day]) {
          let value = parsed.weeklyDiet[day][meal];

          veganForbidden.forEach(word => {
            const regex = new RegExp(`\\b${word}\\b`, "gi");
            value = value.replace(regex, "plant-based alternative");
          });

          parsed.weeklyDiet[day][meal] = value;
        }
      }
    }

    // ✅ SEND FINAL SAFE RESPONSE
    res.json({
      weeklyDiet: parsed.weeklyDiet || {},
      weeklyWorkout: parsed.weeklyWorkout || {},
      confidence: parsed.confidence || "HIGH"
    });

  } catch (err) {
    console.error("❌ AI DIET ERROR:", err);
    res.status(500).json({ message: "Diet/workout AI failed" });
  }
});
   
/* ======================
   START SERVER
   ====================== */
app.listen(PORT, () => {
  console.log(`🚀 FitTrack backend running on port ${PORT}`);
});
