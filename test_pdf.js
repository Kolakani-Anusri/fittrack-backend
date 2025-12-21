import fs from "fs";
import pdfParse from "pdf-parse";

const buffer = fs.readFileSync("sample.pdf");

pdfParse(buffer).then((data) => {
  console.log("TEXT LENGTH:", data.text.length);
  console.log("PREVIEW:", data.text.slice(0, 300));
});
