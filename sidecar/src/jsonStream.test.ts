import { describe, expect, it } from "vitest";
import { JsonObjectStream } from "./jsonStream.ts";

describe("JsonObjectStream", () => {
  it("finds objects with and without newlines between them", () => {
    const s = new JsonObjectStream();
    expect(s.push('{"a":1}\n{"b":2}{"c":3}')).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("joins an object that arrives in parts", () => {
    const s = new JsonObjectStream();
    expect(s.push('{"a":{"b"')).toEqual([]);
    expect(s.push(':[1,2]}')).toEqual([]);
    expect(s.push('}\n{"x"')).toEqual(['{"a":{"b":[1,2]}}']);
    expect(s.push(":0}")).toEqual(['{"x":0}']);
  });

  it("ignores braces and escaped quotes inside strings", () => {
    const s = new JsonObjectStream();
    const obj = '{"t":"a } \\" { b"}';
    expect(s.push(obj.slice(0, 8))).toEqual([]);
    expect(s.push(obj.slice(8))).toEqual([obj]);
    expect(JSON.parse(obj).t).toBe('a } " { b');
  });
});
