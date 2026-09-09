export class LookupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function findCustomer(identifier) {
  if (identifier === "missing") throw new LookupError("IDENTIFIER_MISSING");
  if (identifier === "unexpected") throw new Error("database unavailable");
  return { identifier, name: "Fixture Customer" };
}
