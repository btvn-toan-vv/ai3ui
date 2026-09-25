import "dotenv/config";
import express from "express";
import { dataRouter } from "./routes/data.js";
import { loadDataset } from "./data/load.js";

const app = express();

app.use(express.json({ limit: "2mb" }));

// PORT is also read by vite.config.ts for the /api proxy target.
const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3903;

app.use("/api", dataRouter);

loadDataset(); // fail fast at boot, not on first request
app.listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
