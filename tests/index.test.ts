import { test, expect } from "bun:test";
import { hello } from "../src/index";

test("hello function", () => {
  expect(hello("world")).toBe("Hello, world!");
});
