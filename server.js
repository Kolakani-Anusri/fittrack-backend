// server.js
// FitTrack backend — FINAL WORKING VERSION (Node 22+ / Render safe)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import pdf from "pdf-parse/lib/pdf-parse.js";

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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "JIMMYJAMAI01";
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

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: String,
    mobile: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    age: Number,
    height: Number,
    weight: Number,
    gender: { type: String, enum: ["male", "female"] },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "fittrack_users" }
);

const User = mongoose.model("User", userSchema);

/* ======================
   AUTH ROUTES
   ====================== */
app.post("/register", async (req, res) => {
  try {
    const { name, email, mobile, password, age, height, weight, gender } =
      req.body;

    if (!name || !mobile || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const exists = await User.findOne({ mobile });
    if (exists) {
      return res.status(409).json({ message: "User already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      mobile,
      passwordHash,
      age,
      height,
      weight,
      gender,
    });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ message: "Registered", user, token });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ message: "Register failed" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    const user = await User.findOne({ mobile });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ message: "Login success", user, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

/* ======================
   AI PDF EVALUATION
   ====================== */
app.post("/ai-evaluate-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ success: false, message: "AI disabled" });
    }

    if (!req.file?.buffer) {
      return res
        .status(400)
        .json({ success: false, message: "No PDF uploaded" });
    }

    const parsed = await pdf(req.file.buffer);
    const text = (parsed.text || "").replace(/\s+/g, " ").trim();

    if (text.length < 120) {
      return res.json({
        success: false,
        message: "Unreadable or scanned report",
      });
    }

    const userMeta = req.body.userMeta
      ? JSON.parse(req.body.userMeta)
      : {};

    const prompt = `
Return ONLY valid JSON.
No guessing. No defaults.

{
  "overview": "",
  "evaluation": "",
  "diet": "",
  "doctors": [],
  "furtherDiagnosis": [],
  "limitations": ""
}

Patient:
${JSON.stringify(userMeta)}

Report:
${text.slice(0, 6000)}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const raw = completion.choices[0].message.content;

    const json = JSON.parse(raw);

    res.json({ success: true, evaluation: json });
  } catch (err) {
    console.error("AI error:", err);
    res.status(500).json({ success: false, message: "AI failed" });
  }
});

/* ======================
   START SERVER
   ====================== */
app.listen(PORT, () => {
  console.log(`🚀 FitTrack backend running on port ${PORT}`);
});
