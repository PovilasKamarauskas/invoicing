// Shared by the browser, PDF renderer and persistence layer.
// v1: exact decimal multiplication, half-up rounding per line, sum integer cents.
function decimal(value) {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError("Invalid amount");
  const [coefficient, exponent = "0"] = String(value).split("e");
  const places = (coefficient.split(".")[1] || "").length - Number(exponent);
  const digits = BigInt(coefficient.replace(".", ""));
  return places >= 0
    ? [digits, 10n ** BigInt(places)]
    : [digits * 10n ** BigInt(-places), 1n];
}
function lineCents(item) {
  const [price, pd] = decimal(item.price);
  const [quantity, qd] = decimal(item.quantity);
  const denominator = pd * qd;
  const cents = Number(
    (price * quantity * 100n + denominator / 2n) / denominator,
  );
  if (!Number.isSafeInteger(cents)) throw new RangeError("Amount is too large");
  return cents;
}
function calculate(items, version = 1) {
  if (version === 0) {
    return {
      lines: items.map((i) => i.price * i.quantity),
      total: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    };
  }
  const cents = items.map(lineCents);
  const totalCents = cents.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(totalCents))
    throw new RangeError("Amount is too large");
  return {
    lines: cents.map((value) => value / 100),
    total: totalCents / 100,
    totalCents,
  };
}
function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "1900-01-01" ||
    value > "9999-12-31"
  )
    return false;
  const date = new Date(`${value}T12:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function addDays(value, days) {
  if (!validDate(value)) return "";
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function nextNumber(last) {
  const match = last && last.match(/^(.*?)(\d+)$/);
  if (!match) return "SF 1";
  return `${match[1]}${String(BigInt(match[2]) + 1n).padStart(match[2].length, "0")}`;
}
function workingDays(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth();
  let count = 0;
  for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
    const weekday = new Date(year, month, day, 12).getDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}
function precise(value, places) {
  const [n, d] = decimal(value);
  return (n * 10n ** BigInt(places)) % d === 0n;
}
function validateInvoice(data) {
  const errors = {};
  const required = (key, value, label) => {
    if (typeof value !== "string" || !value.trim())
      errors[key] = `${label} is required.`;
  };
  required("invoiceNumber", data.invoiceNumber, "Invoice number");
  if (
    typeof data.invoiceNumber === "string" &&
    (data.invoiceNumber.length > 100 || /[\r\n"/\\]/.test(data.invoiceNumber))
  )
    errors.invoiceNumber = "Enter a valid invoice number.";
  required("seller.name", data.seller?.name, "Seller name");
  required("buyer.name", data.buyer?.name, "Buyer name");
  if (!validDate(data.invoiceDate))
    errors.invoiceDate = "Enter a valid invoice date.";
  if (!validDate(data.paymentTerm))
    errors.paymentTerm = "Enter a valid payment date.";
  else if (validDate(data.invoiceDate) && data.paymentTerm < data.invoiceDate)
    errors.paymentTerm = "Payment date cannot precede the invoice date.";
  if (
    !Array.isArray(data.items) ||
    !data.items.length ||
    data.items.length > 200
  )
    errors.items = "Add between 1 and 200 line items.";
  else
    data.items.forEach((item, index) => {
      const prefix = `items.${index}`;
      required(
        `${prefix}.description`,
        item?.description,
        `Item ${index + 1} description`,
      );
      required(`${prefix}.unit`, item?.unit, `Item ${index + 1} unit`);
      if (
        typeof item?.quantity !== "number" ||
        !Number.isFinite(item.quantity) ||
        item.quantity <= 0 ||
        item.quantity > 1000000 ||
        !precise(item.quantity, 3)
      )
        errors[`${prefix}.quantity`] =
          "Quantity must be positive, at most 1,000,000, with up to 3 decimal places.";
      if (
        typeof item?.price !== "number" ||
        !Number.isFinite(item.price) ||
        item.price < 0 ||
        item.price > 99999.99 ||
        !precise(item.price, 2)
      )
        errors[`${prefix}.price`] =
          "Price must be between 0 and 99,999.99, with up to 2 decimal places.";
    });
  if (
    !Object.keys(errors).length &&
    calculate(data.items).totalCents >= 10000000
  )
    errors.items = "Invoice total must be below EUR 100,000.";
  return errors;
}
module.exports = {
  calculate,
  lineCents,
  validDate,
  localDate,
  addDays,
  nextNumber,
  workingDays,
  validateInvoice,
};
