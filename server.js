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
import pdfParse from "pdf-parse";

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
const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

/* ======================
   FILE UPLOAD (PDF)
====================== */
const upload = multer({
  storage: multer.memoryStorage(), // ✅ REQUIRED
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.includes("pdf")
      ? cb(null, true)
      : cb(new Error("Only PDF files allowed"));
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
   AUTH — REGISTER
====================== */
app.post("/register", async (req, res) => {
  try {
    let { name, age, height, weight, gender, mobile, email, password } =
      req.body;

    if (!name || !age || !height || !weight || !gender || !mobile || !password) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // ✅ CRITICAL FIX: normalize email
    if (!email || email.trim() === "") {
      email = null;
    }

    const existingUser = await User.findOne({ mobile });
    if (existingUser) {
      return res.status(200).json({
        message: "User already registered. Please login.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

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

    return res.status(201).json({
      message: "User registered successfully",
      user: {
        name,
        age,
        height,
        weight,
        gender,
        mobile,
        email,
      },
    });
  } catch (err) {
    console.error("❌ REGISTER ERROR:", err);
    return res.status(500).json({ message: "Registration failed" });
  }
});

/* ======================
   AUTH — LOGIN
====================== */
app.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    const user = await User.findOne({ mobile });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user._id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.json({ message: "Login success", user, token });
  } catch (err) {
    console.error("❌ LOGIN ERROR:", err);
    return res.status(500).json({ message: "Login failed" });
  }
});

/* ======================
   AI — PDF EVALUATION
====================== */
app.post("/ai-evaluate-pdf", upload.single("report"), async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ success: false, message: "AI disabled" });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: "No PDF uploaded" });
    }

    const parsed = await pdfParse(req.file.buffer);
    const text = (parsed.text || "").replace(/\s+/g, " ").trim();

    if (text.length < 120) {
      return res.json({
        success: false,
        message: "Unreadable or scanned report",
      });
    }

    let userMeta = {};
    if (req.body.userMeta) {
      try {
        userMeta = JSON.parse(req.body.userMeta);
      } catch {
        return res.status(400).json({ success: false, message: "Invalid userMeta" });
      }
    }

    const prompt = `
You are a medical report analysis assistant.

RULES:
- Do NOT guess
- Output ONLY valid JSON
- Educational purpose only

Return JSON:
{
  "overview": "",
  "evaluation": "",
  "diet": "",
  "doctors": [],
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
        model: "gpt-4o-mini", // ✅ SAFE MODEL
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI timeout")), 25000)
      ),
    ]);

    const raw = completion.choices[0].message.content;
    const json = JSON.parse(raw);

    return res.json({ success: true, evaluation: json });
  } catch (err) {
    console.error("❌ AI PDF ERROR:", err);
    return res.status(500).json({ success: false, message: "AI failed" });
  }
});

/* ======================
   AI — DIET & WORKOUT
====================== */
app.post("/ai-diet-workout", async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ message: "AI disabled" });
    }

    const { age, gender, height, weight, bmi, conditions, preference } = req.body;

    const prompt = `
Create personalized diet & workout plan.

Return JSON ONLY:
{
  "dietPlan": "",
  "workoutPlan": "",
  "confidence": "high|medium|low"
}
`;

    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    return res.json(JSON.parse(result.choices[0].message.content));
  } catch {
    return res.status(500).json({ message: "Diet/workout AI failed" });
  }
});

/* ======================
   START SERVER
====================== */
app.listen(PORT, () => {
  console.log(`🚀 FitTrack backend running on port ${PORT}`);
});
