// node --test scripts/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { snippetRange } from "./snippet-range.mjs";

const orders = readFileSync(new URL("../src/OrderService.cs", import.meta.url), "utf8");
const range = (text, props) => snippetRange(text, props);

test("line range without a method", () => {
  assert.deepEqual(range(orders, { start: 10, end: 20 }), { start: 10, end: 20 });
  assert.deepEqual(range(orders, { start: 45, end: 99 }), { start: 45, end: 49 });
  assert.deepEqual(range(orders, {}), { start: 1, end: 49 });
  assert.deepEqual(range(orders, { start: 36, end: 42, before: 1, after: 1 }), { start: 35, end: 43 });
  assert.throws(() => range(orders, { start: 60, end: 70 }), /outside the file/);
  assert.throws(() => range(orders, { start: 20, end: 10 }), /Bad line range/);
});

test("method with a block body", () => {
  assert.deepEqual(range(orders, { method: "Total" }), { start: 36, end: 42 });
  assert.deepEqual(range(orders, { method: "Create" }), { start: 21, end: 32 });
  assert.deepEqual(range(orders, { method: "OrderService.Total" }), { start: 36, end: 42 });
});

test("padding before and after a method", () => {
  assert.deepEqual(range(orders, { method: "Total", before: 1 }), { start: 35, end: 42 });
  assert.deepEqual(range(orders, { method: "Total", before: 1, after: 1 }), { start: 35, end: 43 });
  assert.deepEqual(range(orders, { method: "OrderService", before: 20, after: 5 }), { start: 1, end: 49 });
});

test("method is ignored for start and end", () => {
  assert.deepEqual(range(orders, { method: "Total", start: 1, end: 2 }), { start: 36, end: 42 });
});

test("expression body, property, constant and types", () => {
  assert.deepEqual(range(orders, { method: "Find" }), { start: 46, end: 47 });
  assert.deepEqual(range(orders, { method: "Count" }), { start: 18, end: 18 });
  assert.deepEqual(range(orders, { method: "MaxLines" }), { start: 16, end: 16 });
  assert.deepEqual(range(orders, { method: "OrderService" }), { start: 11, end: 49 });
  assert.deepEqual(range(orders, { method: "Order" }), { start: 9, end: 9 });
});

test("the range follows the method when lines move", () => {
  const moved = "// one\n// two\n// three\n// four\n// five\n" + orders;
  assert.deepEqual(range(moved, { method: "Total" }), { start: 41, end: 47 });
  assert.deepEqual(range(orders.replace(/\n/g, "\r\n"), { method: "Total" }), { start: 36, end: 42 });
});

test("errors", () => {
  assert.throws(() => range(orders, { method: "Missing" }), /No declaration named "Missing"/);
  assert.throws(() => range(orders, { method: "OrderService.Missing" }), /"OrderService.Missing"/);
  assert.throws(() => range(orders, { method: "Total", overload: 2 }), /Only 1 declaration/);
  assert.throws(() => range(orders, { method: "Total-B3" }), /Bad method name/);
  assert.throws(() => range(orders, { method: "Total", before: -1 }), /before must be/);
});

const tricky = `public class Billing
{
    // Total(order) is called below; this comment must not match.
    private const string Note = "Total(x) { not code }";
    private const string Folder = @"C:\\temp\\";

    public void Run(Order o)
    {
        var t = Total(o);
        Log($"total is {t}");
        if (Total(o) > 0) Save(o);
    }

    public decimal Total(Order order)
    {
        var brace = '{';
        return order.Sum;
    }

    public decimal Total(Order order, decimal tax) =>
        Total(order) * (1 + tax);

    public class Nested
    {
        public int Total() { return 0; }
    }
}

public interface IBilling
{
    decimal Total(Order order);
}
`;

test("calls, comments, strings and char literals do not count", () => {
  assert.deepEqual(range(tricky, { method: "Total" }), { start: 14, end: 18 });
  assert.deepEqual(range(tricky, { method: "Run" }), { start: 7, end: 12 });
});

test("overloads, nested types and interface members", () => {
  assert.deepEqual(range(tricky, { method: "Total", overload: 2 }), { start: 20, end: 21 });
  assert.deepEqual(range(tricky, { method: "Nested.Total" }), { start: 25, end: 25 });
  assert.deepEqual(range(tricky, { method: "Billing.Nested" }), { start: 23, end: 26 });
  assert.deepEqual(range(tricky, { method: "IBilling.Total" }), { start: 31, end: 31 });
});

const ts = `import { Order } from "./order";

total(order);

export class Cart {
  private items: Order[] = [];

  total(tax: number): number {
    const label = \`total { \${tax} }\`;
    return this.items.length * tax;
  }
}

export function total(order: Order): number {
  return order.sum;
}

export const format = (value: number) => {
  return value.toFixed(2);
};
`;

test("TypeScript class method, function and arrow function", () => {
  assert.deepEqual(range(ts, { method: "Cart.total" }), { start: 8, end: 11 });
  assert.deepEqual(range(ts, { method: "total" }), { start: 8, end: 11 });
  assert.deepEqual(range(ts, { method: "total", overload: 2 }), { start: 14, end: 16 });
  assert.deepEqual(range(ts, { method: "format" }), { start: 18, end: 20 });
  assert.deepEqual(range(ts, { method: "items" }), { start: 6, end: 6 });
});
