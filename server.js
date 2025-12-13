// server.js
// FitTrack backend — full version with PDF upload + AI evaluation
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const OpenAI = require("openai");

const app = express();

/* ======================
   CONFIG
   ====================== */
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "FITTRACK_FALLBACK_SECRET";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "JIMMYJAMAI01";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

/* ======================
   OPENAI CLIENT
   ====================== */
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
  console.warn("⚠️ OPENAI_API_KEY not set — AI functionality will be disabled.");
}

/* ======================
   MIDDLEWARE
   ====================== */
// Increase JSON/body limits (helps avoid 413 when text is large)
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use(
  cors({
    origin: FRONTEND_URL === "*" ? "*" : FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-password"],
  })
);

/* ======================
   FILE UPLOAD SETUP
   ====================== */
// Allow PDF uploads up to 20 MB. If you expect larger PDFs, increase this value.
const upload = multer({
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.includes("pdf")) {
      cb(new Error("Only PDF files are allowed"));
    } else {
      cb(null, true);
    }
  },
});



/* ======================
   DATABASE
   ====================== */
if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing. Set it in .env or Render environment.");
  process.exit(1);
}
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, trim: true },
    mobile: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    age: { type: Number, required: true },
    height: { type: Number, required: true },
    weight: { type: Number, required: true },
    gender: { type: String, enum: ["male", "female"], required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "fittrack_users" }
);

const User = mongoose.model("User", userSchema);

/* ======================
   ROUTES
   ====================== */

// Health check
app.get("/", (req, res) => {
  res.json({ message: "✅ FitTrack backend running" });
});

/* REGISTER */
app.post("/register", async (req, res) => {
  try {
    const { name, email, mobile, password, age, height, weight, gender } =
      req.body || {};

    if (!name || !mobile || !password || !age || !height || !weight || !gender) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const existing = await User.findOne({ mobile: mobile.trim() });
    if (existing) {
      return res.status(409).json({ message: "User already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: name.trim(),
      email: email ? email.trim() : undefined,
      mobile: mobile.trim(),
      passwordHash,
      age: Number(age),
      height: Number(height),
      weight: Number(weight),
      gender,
    });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({
      message: "User registered successfully ✅",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        age: user.age,
        height: user.height,
        weight: user.weight,
        gender: user.gender,
        createdAt: user.createdAt,
      },
      token,
    });
  } catch (err) {
    console.error("❌ /register error:", err);
    return res.status(500).json({ message: "Registration failed." });
  }
});

/* LOGIN */
app.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body || {};
    if (!mobile || !password) {
      return res.status(400).json({ message: "Mobile and password required." });
    }

    const user = await User.findOne({ mobile: mobile.trim() });
    if (!user) return res.status(401).json({ message: "Invalid credentials." });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials." });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        age: user.age,
        height: user.height,
        weight: user.weight,
        gender: user.gender,
      },
    });
  } catch (err) {
    console.error("❌ /login error:", err);
    return res.status(500).json({ message: "Login failed." });
  }
});

/* ADMIN GUARD */
function adminGuard(req, res, next) {
  const pwd = req.headers["x-admin-password"] || req.body?.adminPassword;
  if (!pwd || pwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

/* GET ALL USERS */
app.get("/admin/users", adminGuard, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    res.json({ users });
  } catch (err) {
    console.error("❌ /admin/users error:", err);
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

/* DOWNLOAD CSV */
app.get("/admin/users/csv", adminGuard, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    const headers = [
      "Name",
      "Mobile",
      "Email",
      "Age",
      "Gender",
      "Height_cm",
      "Weight_kg",
      "CreatedAt",
    ];

    const rows = users.map((u) => [
      u.name || "",
      u.mobile || "",
      u.email || "",
      u.age ?? "",
      u.gender || "",
      u.height ?? "",
      u.weight ?? "",
      u.createdAt ? u.createdAt.toISOString() : "",
    ]);

    const escapeCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [headers.join(","), ...rows.map((r) => r.map(escapeCell).join(","))].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="fittrack_users.csv"');
    res.send(csv);
  } catch (err) {
    console.error("❌ /admin/users/csv error:", err);
    res.status(500).json({ message: "Failed to generate CSV" });
  }
});

/* ======================
   AI: TEXT EVALUATION (optional route; useful if you keep sending text)
   ====================== */
app.post("/ai-evaluate", async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ message: "AI not configured on server." });
    }

    const { text, userMeta } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ message: "Missing text." });
    }

    const cleaned = text.trim();
    if (cleaned.length < 80) {
      return res.json({
        evaluation: {
          isMedical: false,
          reason: "Text too short or unclear for medical report.",
        },
      });
    }

    const prompt = `
You are a careful medical report classifier and summarizer.
First, decide if the text is a medical report (lab test, scan, discharge summary, prescription, doctor's notes).
If NOT medical, return JSON: { "isMedical": false, "reason": "..." }
If medical, return JSON:
{
  "isMedical": true,
  "reason": "...",
  "summary": "...",
  "keyFindings": ["..."],
  "riskLevel": "low|medium|high",
  "redFlags": ["..."],
  "recommendations": ["..."],
  "lifestyleTips": ["..."]
}
Return JSON only. Be conservative and avoid giving final diagnoses.
User meta: ${JSON.stringify(userMeta || {}, null, 2)}
Report text (trimmed): ${cleaned.slice(0, 6000)}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "You carefully interpret medical reports." }, { role: "user", content: prompt }],
      temperature: 0.2,
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("AI JSON parse error:", e, raw);
      return res.status(500).json({ message: "AI returned invalid JSON." });
    }

    return res.json({ evaluation: parsed });
  } catch (err) {
    console.error("❌ /ai-evaluate error:", err);
    return res.status(500).json({ message: "AI evaluation failed." });
  }
});

/* ======================
   AI: PDF UPLOAD & EVALUATE (recommended flow)
   Accepts: multipart/form-data with "report" (PDF) and optional "userMeta" (JSON string)
   ====================== */
app.post("/ai-evaluate-pdf", upload.single("report"), async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ message: "AI not configured on server." });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No PDF uploaded." });
    }

    // extract text
    const pdfData = await pdfParse(req.file.buffer);
    const text = (pdfData.text || "").trim();

    if (!text || text.length < 100) {
      return res.json({
        ok: true,
        isMedical: false,
        reason: "Uploaded PDF does not contain enough readable text to be a medical report.",
      });
    }

    // optional userMeta (stringified)
    let userMeta = {};
    try {
      if (req.body && req.body.userMeta) {
        userMeta = JSON.parse(req.body.userMeta);
      }
    } catch (e) {
      // ignore parse errors
    }

    const prompt = `
You are a cautious medical report classifier and summarizer.
First: decide if the provided text is a medical report (lab test, scan, discharge summary, prescription, doctor notes).
If NOT medical: return JSON { "isMedical": false, "reason": "..." }
If medical: return JSON:
{
  "isMedical": true,
  "summary": "...",
  "keyFindings": ["..."],
  "riskLevel": "low|medium|high",
  "redFlags": ["..."],
  "recommendations": ["..."],
  "lifestyleTips": ["..."]
}
Return JSON ONLY. Be conservative and avoid diagnosis.
User meta: ${JSON.stringify(userMeta || {}, null, 2)}
Report text (trimmed): ${text.slice(0, 6000)}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "You carefully analyze medical reports." }, { role: "user", content: prompt }],
      temperature: 0.2,
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("AI JSON parse error:", e, raw);
      return res.status(500).json({ message: "AI returned invalid JSON." });
    }

    if (!parsed.isMedical) {
      return res.json({ ok: true, isMedical: false, reason: parsed.reason || "Not a medical report" });
    }

    return res.json({ ok: true, isMedical: true, evaluation: parsed });
  } catch (err) {
    console.error("❌ /ai-evaluate-pdf error:", err);
    // Multer file filter / size errors return here:
    if (err.message && err.message.includes("Only PDF")) {
      return res.status(400).json({ message: err.message });
    }
    return res.status(500).json({ message: "AI PDF evaluation failed." });
  }
});

/* START */
const server = app.listen(PORT, () => {
  console.log(`🚀 FitTrack backend running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    process.exit(0);
  });
});
