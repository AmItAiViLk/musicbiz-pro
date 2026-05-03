// Vercel serverless function — proxies Morning (חשבונית ירוקה) API to avoid browser CORS
// Called by: GET /api/morning-status?clientName=<name>
// Headers: x-morning-key, x-morning-secret

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "x-morning-key, x-morning-secret",
  );

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const clientName = req.query.clientName;
  const apiKey = req.headers["x-morning-key"];
  const secret = req.headers["x-morning-secret"];

  if (!apiKey || !secret)
    return res.status(400).json({ error: "Missing Morning credentials" });
  if (!clientName) return res.status(400).json({ error: "Missing clientName" });

  try {
    const auth = Buffer.from(`${apiKey}:${secret}`).toString("base64");
    const url = `https://api.morning.co.il/v1/incomes?clientName=${encodeURIComponent(clientName)}&pageSize=5&sort=createdAt:desc`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
