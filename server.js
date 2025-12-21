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
      return res.status(200).json({ message: "User already exists" });
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
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ message: "Server error during registration" });
  }
});

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
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI timeout")), 25000)
      ),
    ]);

    const raw = completion.choices[0].message.content;

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      console.error("❌ AI RAW RESPONSE:", raw);
      return res.status(500).json({
        success: false,
        message: "AI returned invalid JSON",
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
    if (!openai) {
      return res.status(503).json({ message: "AI disabled" });
    }

    const { age, gender, height, weight, bmi, conditions, preference } = req.body;

    const prompt = `
You are a certified fitness and nutrition assistant.

Create:
1) Personalized diet plan
2) Personalized workout plan

User details:
Age: ${age}
Gender: ${gender}
Height: ${height}
Weight: ${weight}
BMI: ${bmi}
Medical Conditions: ${conditions || "None"}
Food Preference: ${preference || "Vegetarian"}

Return JSON ONLY:
{
  "dietPlan": "",
  "workoutPlan": "",
  "confidence": "high|medium|low"
}
`;

    const result = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    res.json(JSON.parse(result.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ message: "Diet/workout AI failed" });
  }
});


/* ======================
   START SERVER
   ====================== */
app.listen(PORT, () => {
  console.log(`🚀 FitTrack backend running on port ${PORT}`);
});
