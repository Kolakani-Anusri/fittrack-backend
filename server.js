// server.js
// FitTrack backend — FINAL STABLE VERSION (Node 22+ / Render safe)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

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
   OPENAI CLIENT
   ====================== */
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
  console.warn("⚠️ OPENAI_API_KEY not set — AI disabled");
}

/* ======================
   FILE UPLOAD (PDF)
   ====================== */
const upload = multer({
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
    const { name, age, height, weight, gender, mobile, email, password } =
      req.body;

    if (!name || !age || !height || !weight || !gender || !mobile || !password) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const existingUser = await User.findOne({ mobile });

    if (existingUser) {
      return res.status(200).json({
        message: "User already registered. Please login."
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      name,
      age,
      height,
      weight,
      gender,
      mobile,
      email,
      password: hashedPassword,
    });

    await newUser.save();

    res.status(201).json({
      message: "User registered successfully",
      user: { name, age, height, weight, gender, mobile, email },
    });
  } catch (err) {
    console.error("❌ REGISTER ERROR FULL:", err);
    res.status(500).json({ 
      message: "Server error during registration",
      error: err.message,
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
  console.log("🟢 AI route hit");

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
        message: "No PDF uploaded",
      });
    }

    console.log("📄 Parsing PDF...");
    const parsed = await pdfParse(req.file.buffer);
    if (!parsed.text || parsed.text.length < 200) {
      return res.status(200).json({
        success: false,
        message: "This PDF looks scanned or unreadable.",
      });
    }

    const text = (parsed.text || "").replace(/\s+/g, " ").trim();
    console.log("📝 Extracted text length:", text.length);

    if (text.length < 120) {
      return res.json({
        success: false,
        message: "Unreadable or scanned report",
      });
    }

    let userMeta = {};
    try {
      userMeta = req.body.userMeta ? JSON.parse(req.body.userMeta) : {};
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid userMeta JSON",
      });
    }

    const prompt = `
You are a medical report analysis assistant.

RULES (STRICT):
- Do NOT guess values
- Do NOT assume missing data
- If data is insufficient, say so clearly
- Educational purpose only (India context)
- Output ONLY valid JSON

Return JSON in this EXACT format:
{
  "overview": "",
  "evaluation": "",
  "diet": "",
  "doctors": [
    {
      "name": "",
      "specialization": "",
      "hospital": "",
      "location": "",
      "type": "government|private"
    }
  ],
  "furtherDiagnosis": [],
  "limitations": ""
}

Patient Details:
${JSON.stringify(userMeta, null, 2)}

Medical Report Text:
${text.slice(0, 4000)}
`;

    const completion = await Promise.race([
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI timeout")), 25000)
      ),
    ]);

    const raw = completion.choices[0].message.content;

    console.log("🧠 AI RAW RESPONSE ↓↓↓");
    console.log(raw);

    // Safely extract JSON from AI response
    let json;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error("No JSON found in AI response");
      }
      json = JSON.parse(match[0]);
    } catch (err) {
      console.error("❌ JSON PARSE FAILED:", err.message);
      return res.status(200).json({
        success: false,
        message: "AI could not understand this report. Please try another PDF.",
      });
    }


    return res.json({ success: true, evaluation: json });
  } catch (err) {
    console.error("❌ AI ROUTE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "AI evaluation failed",
    });
  }
});




app.post("/ai-diet-workout", async (req, res) => {
  try {
    const {
      age,
      gender,
      height,
      weight,
      bmi,
      preference = "Vegetarian",
      healthIssues = []
    } = req.body;

    if (!age || !gender || !height || !weight || !bmi) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // ===============================
    // 🔥 STRONG STRUCTURED AI PROMPT
    // ===============================
    const prompt = `
You are an AI fitness trainer and clinical nutritionist.

Generate a STRICT JSON response ONLY (no explanation text outside JSON).

USER PROFILE:
- Age: ${age}
- Gender: ${gender}
- Height: ${height} cm
- Weight: ${weight} kg
- BMI: ${bmi}
- Food Preference: ${preference}
- Health Issues: ${healthIssues.join(", ") || "None"}

RULES:
- Generate a 7-day plan (Sunday to Saturday)
- Include meal TIMINGS
- Include REASONS (why this food is better)
- Workout must be SAFE based on BMI and gender
- Use Indian food
- Vegan = NO milk, curd, paneer, ghee, butter, eggs, meat
- Diet MUST strictly follow the food preference.
- Workout intensity MUST match BMI and gender.
- Be realistic, Indian-friendly, and safe.
- Avoid medical diagnosis.
- DO NOT add explanations.
- DO NOT add markdown.
- DO NOT add extra text.

JSON FORMAT (MANDATORY):

{
  "weeklyDiet": {
    "Sunday": {
      "breakfast": "7:30 AM – Oats porridge with nuts (rich in fiber & iron)",
      "juice": "10:30 AM – Pomegranate juice (improves hemoglobin)",
      "lunch": "1:30 PM – Rice + dal + spinach curry (iron rich)",
      "snack": "5:00 PM – Roasted chana (protein source)",
      "dinner": "8:00 PM – Chapati + vegetable curry (light & digestible)"
    }
  },
  "weeklyWorkout": {
    "Sunday": {
      "activity": "Brisk walking",
      "duration": "30 minutes",
      "notes": "Improves metabolism without strain"
    }
  },
  "confidence": "HIGH"
}
`;

    // ===============================
    // 🤖 SINGLE AI CALL
    // ===============================
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    });

    const rawText = completion.choices[0].message.content;
    console.log("🔵 RAW AI RESPONSE START");
    console.log(rawText);
    console.log("🔵 RAW AI RESPONSE END");


    // ===============================
    // 🛡️ SAFE JSON PARSE
    // ===============================
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error("❌ AI JSON PARSE FAILED:", rawText);
      return res.status(500).json({
        message: "AI returned invalid format",
      });
    }

    // ===============================
    // ✅ FINAL RESPONSE
    // ===============================
    res.json({
      weeklyDiet: parsed.weeklyDiet,
      weeklyWorkout: parsed.weeklyWorkout,
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
