// models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },
    mobile: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    password: { type: String, required: true },
    age: Number,
    height: Number,
    weight: Number,
    gender: {
      type: String,
      enum: ["male", "female", "other"],
      default: "other",
    },
    bmi: Number,
    lastLogin: Date,
  },
  { timestamps: true }
);

// ✅ Prevent model re-declaration
const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
