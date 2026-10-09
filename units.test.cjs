const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function app(preference) {
  const context = vm.createContext({
    FormData: class { constructor(values) { this.values = values; } get(key) { return this.values[key] ?? ''; } },
    localStorage: { setItem() {} }
  });
  vm.runInContext(readFileSync(__dirname + '/app.js', 'utf8'), context);
  vm.runInContext(`DB = { units: '${preference}', kids: [{ id: 'kid', birth: '2026-01-01' }], measurements: [] }; render = function () {};`, context);
  return context;
}

for (const preference of ['imperial', 'metric']) {
  test(`saves mixed input units independently of ${preference} display preference`, () => {
    const c = app(preference);
    c.form = { kidId: 'kid', date: '2026-02-01', weight: '5', weightUnit: 'kg', length: '20', lengthUnit: 'in', head: '35', headUnit: 'cm' };
    vm.runInContext('handleMsrForm(form)', c);
    const record = vm.runInContext('DB.measurements[0]', c);
    assert.equal(record.weightKg, 5);
    assert.equal(record.lengthCm, 50.8);
    assert.equal(record.headCm, 35);
    assert.equal(vm.runInContext('fmtWeight(DB.measurements[0].weightKg)', c), preference === 'metric' ? '5.0 kg' : '11.0 lb');
  });
}

test('editing converts imperial input into metric storage and preserves empty fields', () => {
  const c = app('metric');
  vm.runInContext("DB.measurements.push({ id: 'existing', kidId: 'kid', date: '2026-02-01', weightKg: 5, lengthCm: 50, headCm: 35 })", c);
  c.form = { id: 'existing', kidId: 'kid', date: '2026-02-02', weight: '11.0231', weightUnit: 'lb', length: '', lengthUnit: 'cm', head: '14', headUnit: 'in' };
  vm.runInContext('handleMsrForm(form)', c);
  const record = vm.runInContext('DB.measurements[0]', c);
  assert.ok(Math.abs(record.weightKg - 5) < 1e-10);
  assert.equal(record.lengthCm, null);
  assert.equal(record.headCm, 35.56);
  assert.equal(vm.runInContext('DB.measurements.length', c), 1);
});

test('switching input units converts the value without changing the display preference', () => {
  const c = app('imperial');
  c.input = { value: '5' };
  c.unit = { value: 'kg' };
  c.buttons = ['kg', 'lb'].map(v => ({ dataset: { v }, classList: { toggle() {} }, setAttribute() {} }));
  c.button = { closest: () => ({ elements: { weight: c.input, weightUnit: c.unit }, querySelectorAll: () => c.buttons }) };
  assert.equal(vm.runInContext("typeof Actions['set-input-unit']", c), 'function');
  vm.runInContext("Actions['set-input-unit']({ field: 'weight', v: 'lb' }, button)", c);
  assert.ok(Math.abs(Number(c.input.value) - 11.0231) < 1e-9);
  assert.equal(c.unit.value, 'lb');
  vm.runInContext("Actions['set-input-unit']({ field: 'weight', v: 'kg' }, button)", c);
  assert.ok(Math.abs(Number(c.input.value) - 5) < 1e-9);
  assert.equal(vm.runInContext('DB.units', c), 'imperial');
  c.input.value = '';
  vm.runInContext("Actions['set-input-unit']({ field: 'weight', v: 'lb' }, button)", c);
  assert.equal(c.input.value, '');
});
