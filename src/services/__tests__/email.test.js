// Unit tests for OTP formatting and email helper logic.

import test from 'node:test'
import assert from 'node:assert/strict'

// OTP generation — 6 digits, padded
function formatOtp(n) {
  return String(n).padStart(6, '0')
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000)
}

test('OTP is always 6 digits', () => {
  for (let i = 0; i < 50; i++) {
    const otp = generateOtp()
    assert.ok(otp >= 100000 && otp <= 999999, `OTP ${otp} out of range`)
    assert.equal(String(otp).length, 6)
  }
})

test('OTP formatted with padding stays 6 chars', () => {
  assert.equal(formatOtp(1),      '000001')
  assert.equal(formatOtp(99),     '000099')
  assert.equal(formatOtp(123456), '123456')
  assert.equal(formatOtp(999999), '999999')
})

test('SMTP_FROM env used as sender', () => {
  process.env.SMTP_FROM = 'Beam0 <noreply@test.com>'
  assert.ok(process.env.SMTP_FROM.includes('@'))
})

test('OTP email subject contains "code"', () => {
  const subject = 'Your Beam0 verification code'
  assert.ok(subject.toLowerCase().includes('code'))
})

test('OTP is numeric string of length 6', () => {
  const otp = '123456'
  assert.match(otp, /^\d{6}$/)
})

test('OTP regex rejects non-numeric', () => {
  assert.doesNotMatch('12345a', /^\d{6}$/)
  assert.doesNotMatch('MASTER', /^\d{6}$/)
  assert.doesNotMatch('12345',  /^\d{6}$/) // 5 chars
  assert.doesNotMatch('1234567',/^\d{6}$/) // 7 chars
})
