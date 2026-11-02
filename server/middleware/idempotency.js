function requireIdempotencyKey(req, res, next) {
  const key = req.get("Idempotency-Key");
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    return res.status(400).json({
      error: "Idempotency-Key is required: use 1-128 letters, digits, dots, underscores, colons, or hyphens, starting with a letter or digit",
    });
  }
  req.idempotencyKey = key;
  next();
}

module.exports = requireIdempotencyKey;
