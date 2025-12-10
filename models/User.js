// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true, // allows some users without email
    },
    mobile: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // allows some users without mobile
    },
    password: {
      type: String,
      required: true,
    },
    age: {
      type: Number,
    },
    height: {
      type: Number, // in cm
    },
    weight: {
      type: Number, // in kg
    },
    gender: {
      type: String,
      enum: ["male", "female", "other"],
      default: "other",
    },
    bmi: {
      type: Number,
    },
    lastLogin: {
      type: Date,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

const User = mongoose.model("User", userSchema);

module.exports = User;
