// ==============================
// FitTrack Backend (Mongo + Users)
// ==============================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "FITTRACK_SECRET";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "JIMMYJAMAI01";

// ---------- MIDDLEWARE ----------
app.use(cors({ origin: "*"}));
app.use(express.json());

// ---------- DB CONNECTION ----------
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB error:", err.message));

// ---------- USER MODEL ----------
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String },
    mobile: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    age: Number,
    height: Number,
    weight: Number,
    gender: String,
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "fittrack_users" }
);

const User = mongoose.model("User", userSchema);

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
  res.json({ message: "✅ FitTrack backend running" });
});

// ---------- REGISTER USER ----------
app.post("/register", async (req, res) => {
  try {
    const { name, email, mobile, password, age, height, weight, gender } = req.body;

    if (!name || !mobile || !password) {
      return res.status(400).json({ message: "Missing required fields" });
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

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({
      message: "User registered",
      user: {
        id: user._id,
        name: user.name,
        mobile: user.mobile,
      },
      token,
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------- LOGIN USER ----------
app.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password) {
      return res
        .status(400)
        .json({ message: "Mobile and password are required." });
    }

    const user = await User.findOne({ mobile: mobile.trim() });
    if (!user) {
      return res
        .status(401)
        .json({ message: "Invalid mobile or password." });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res
        .status(401)
        .json({ message: "Invalid mobile or password." });
    }

    const token = jwt.sign(
      { id: user._id, mobile: user.mobile },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

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
    return res
      .status(500)
      .json({ message: "Internal server error during login." });
  }
});

// ---------- ADMIN AUTH ----------
function checkAdmin(req, res, next) {
  const pwd = req.header("x-admin-password");
  if (!pwd || pwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid admin password" });
  }
  next();
}

// ---------- GET ALL USERS (PERMANENT) ----------
app.get("/admin/users", checkAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: "Failed to load users" });
  }
});

// ---------- START SERVER ----------
const server = app.listen(PORT, () => {
  console.log(`🚀 FitTrack backend running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down gracefully.");
  server.close(() => {
    process.exit(0);
  });
});
