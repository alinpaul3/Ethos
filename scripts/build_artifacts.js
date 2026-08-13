import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const mlDir = path.join(process.cwd(), "ml");
const scalerPath = path.join(mlDir, "scaler.pkl");
const modelPath = path.join(mlDir, "personality_model.pkl");

console.log("[Node Artifact Runner] Checking ML model artifacts...");
const pythonCmd = process.platform === "win32" ? "python" : "python3";

try {
  const initScript = path.join(mlDir, "init_ml.py");
  console.log(`[Node Artifact Runner] Running ${pythonCmd} "${initScript}"...`);
  const output = execSync(`${pythonCmd} "${initScript}"`, { encoding: "utf-8" });
  console.log(output);

  if (fs.existsSync(scalerPath) && fs.existsSync(modelPath)) {
    console.log("[Node Artifact Runner] Verification SUCCESS: scaler.pkl and personality_model.pkl generated successfully!");
  } else {
    console.error("[Node Artifact Runner] Error: Model files still missing after execution.");
  }
} catch (err) {
  console.error("[Node Artifact Runner] Execution failed:", err);
}
