import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateUsername,
  validatePassword,
  validateVpa,
  validatePositivePaise,
  validatePinOrOtp,
  validateIndianMobile,
  validateIfsc,
  validateCardPanLuhn,
  validateAnchorDay,
  validateNonEmptyString,
} from "../src/index.ts";

describe("Core Input Validators — Strict 400 Validation Across All Payment Rails", () => {
  it("Validates usernames, passwords, VPAs, integer paise, PINs/OTPs, Indian mobiles, IFSC, Luhn PAN & anchor days", () => {
    assert.equal(validateUsername("Switch.Admin"), "switch.admin");
    assert.throws(() => validateUsername("ab"), { statusCode: 400 });
    assert.throws(() => validateUsername("bad user!"), { statusCode: 400 });

    assert.equal(validatePassword("SwitchAdmin#2026"), "SwitchAdmin#2026");
    assert.throws(() => validatePassword("short"), { statusCode: 400 });

    assert.equal(validateVpa("Anita@PSP1"), "anita@psp1");
    assert.throws(() => validateVpa("not-a-vpa"), { statusCode: 400 });

    assert.equal(validatePositivePaise(50_000), 50_000);
    assert.throws(() => validatePositivePaise(0), { statusCode: 400 });
    assert.throws(() => validatePositivePaise(-100), { statusCode: 400 });
    assert.throws(() => validatePositivePaise(100.5), { statusCode: 400 });
    assert.throws(() => validatePositivePaise(Number.NaN), { statusCode: 400 });

    assert.equal(validatePinOrOtp("1234"), "1234");
    assert.equal(validatePinOrOtp("654321"), "654321");
    assert.throws(() => validatePinOrOtp("123"), { statusCode: 400 });
    assert.throws(() => validatePinOrOtp("abcd"), { statusCode: 400 });

    assert.equal(validateIndianMobile("9876543210"), "9876543210");
    assert.throws(() => validateIndianMobile("1234567890"), { statusCode: 400 });
    assert.throws(() => validateIndianMobile("98765"), { statusCode: 400 });

    assert.equal(validateIfsc("sbin0001234"), "SBIN0001234");
    assert.throws(() => validateIfsc("INVALID"), { statusCode: 400 });

    assert.equal(validateCardPanLuhn("4242-4242-4242-4242"), "4242424242424242");
    assert.throws(() => validateCardPanLuhn("4242424242424243"), { statusCode: 400 });
    assert.throws(() => validateCardPanLuhn("123"), { statusCode: 400 });

    assert.equal(validateAnchorDay(31), 31);
    assert.throws(() => validateAnchorDay(0), { statusCode: 400 });
    assert.throws(() => validateAnchorDay(32), { statusCode: 400 });

    assert.equal(validateNonEmptyString("  Anita  ", "fullName", 2, 80), "Anita");
    assert.throws(() => validateNonEmptyString("A", "fullName", 2, 80), { statusCode: 400 });
  });
});
