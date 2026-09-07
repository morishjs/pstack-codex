import { findCustomer } from "./service.mjs";

export function getCustomer(identifier) {
  try {
    return { status: 200, body: findCustomer(identifier) };
  } catch {
    return { status: 500, body: { code: "INTERNAL_ERROR" } };
  }
}
