import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalFactsHash, normalizeInput, normalizeRibFacts, validateImage } from '../gemini/lib/facts.js';

function image(mimeType, buffer) { return { mimeType, data: buffer.toString('base64') }; }
function png() {
  const buffer = Buffer.alloc(45);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(buffer);
  buffer.writeUInt32BE(1, 16); buffer.writeUInt32BE(1, 20); buffer.write('IEND', 37, 'ascii'); buffer[44] = 0x82;
  return buffer;
}

test('equivalent rib ordinal phrasings normalize to the same fact hash', () => {
  const variants = ['左侧第3、4肋骨骨折', '左边第三根和第四根肋骨骨折', '左侧第3及第4肋骨分别骨折'];
  const facts = variants.map(normalizeRibFacts);
  assert.equal(canonicalFactsHash(facts[0]), canonicalFactsHash(facts[1]));
  assert.equal(canonicalFactsHash(facts[0]), canonicalFactsHash(facts[2]));
  assert.deepEqual(facts[0].find(fact => fact.field === 'fractured_rib_numbers').value, [3, 4]);
});

test('rib ordinal, number of ribs, and fracture sites remain distinct', () => {
  const oneSite = normalizeRibFacts('第六肋骨骨折1处');
  const sixRibs = normalizeRibFacts('六根肋骨骨折');
  assert.deepEqual(oneSite.find(fact => fact.field === 'fractured_rib_numbers').value, [6]);
  assert.equal(oneSite.find(fact => fact.field === 'fracture_site_count').value, 1);
  assert.equal(oneSite.find(fact => fact.field === 'fractured_rib_count').value, 1);
  assert.equal(sixRibs.find(fact => fact.field === 'fractured_rib_count').value, 6);
  assert.equal(sixRibs.some(fact => fact.field === 'fractured_rib_numbers'), false);
});

test('explicit fracture-site counts are recognized before and after the rib fracture wording', () => {
  const examples = [
    ['左侧第3肋骨有2处骨折线', 2],
    ['两处肋骨骨折', 2],
  ];
  for (const [text, expected] of examples) {
    assert.equal(normalizeRibFacts(text).find(fact => fact.field === 'fracture_site_count')?.value, expected, text);
  }
});

test('a total fracture-site count applies across comma-separated rib descriptions', () => {
  const facts = normalizeRibFacts('本次事故后左侧第3肋骨有1处骨折线，左侧第4肋骨有1处骨折线，共2处骨折。既往没有肋骨损伤');
  assert.equal(facts.find(fact => fact.field === 'fracture_site_count')?.value, 2);
});

test('a sentence total covering rib and non-rib fractures is not assigned to the rib count', () => {
  const facts = normalizeRibFacts('左侧第3肋骨有1处骨折线，鼻骨骨折，共2处骨折');
  assert.equal(facts.some(fact => fact.field === 'fracture_site_count' && fact.value === 2), false);
  assert.equal(facts.find(fact => fact.field === 'fracture_site_count')?.value, 1);
});

test('a current rib fracture total does not include a prior rib fracture in the same sentence', () => {
  const facts = normalizeRibFacts('本次左侧第3肋骨骨折，既往左侧第4肋骨骨折，共2处骨折');
  assert.equal(facts.some(fact => fact.field === 'fracture_site_count'), false);
  assert.equal(facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture'), true);
  assert.equal(facts.some(fact => fact.field === 'prior_injury' && fact.value === 'rib_fracture'), true);
});

test('a current fracture cue after a prior-injury denial keeps the new rib fracture current', () => {
  const facts = normalizeRibFacts('既往没有肋骨损伤但本次左侧第3肋骨骨折');
  assert.equal(facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture' && fact.certainty === 'reported'), true);
  assert.equal(facts.some(fact => fact.field === 'prior_injury'), false);
});

test('a combined rib and nasal fracture clause does not assign its total to the rib count', () => {
  const examples = [
    '左侧第3肋骨骨折并鼻骨骨折，共2处骨折',
    '左侧第3肋骨骨折并L1椎体压缩性骨折，共2处骨折',
  ];
  for (const text of examples) {
    const facts = normalizeRibFacts(text);
    assert.equal(facts.some(fact => fact.field === 'fracture_site_count'), false, text);
    assert.equal(facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture'), true, text);
  }
});

test('rib pain is not parsed as a rib fracture when a different bone fractures in the same clause', () => {
  const facts = normalizeRibFacts('左侧肋骨区域疼痛伴鼻骨骨折');
  assert.equal(facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture'), false);
});

test('laterality belongs to its own rib clause and later explicit side does not leak', () => {
  const facts = normalizeRibFacts('左侧第3肋骨骨折，右侧第5肋骨骨折');
  assert.deepEqual(facts.filter(fact => fact.field === 'laterality').map(fact => fact.value), ['left', 'right']);
  assert.deepEqual(facts.filter(fact => fact.field === 'fractured_rib_numbers').map(fact => fact.value), [[3], [5]]);
});

test('input normalization preserves medical numbers and negation', () => {
  assert.equal(normalizeInput(' 左侧第3、4肋骨骨折\r\n未见移位 '), '左侧第3、4肋骨骨折\n未见移位');
  assert.notEqual(canonicalFactsHash(normalizeRibFacts('第六肋骨骨折')), canonicalFactsHash(normalizeRibFacts('排除第六肋骨骨折')));
});

test('image validation sniffs actual supported bytes and rejects spoofed, malformed, empty, and oversized data', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(7), Buffer.from([0x3b])]);
  const webp = Buffer.alloc(20); webp.write('RIFF', 0, 'ascii'); webp.writeUInt32LE(webp.length - 8, 4); webp.write('WEBP', 8, 'ascii');
  const bmp = Buffer.alloc(26); bmp.write('BM', 0, 'ascii'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(1, 18); bmp.writeUInt32LE(1, 22);
  const heic = Buffer.from('00000018667479706865696300000000', 'hex');
  const heif = Buffer.from('00000018667479706d69663100000000', 'hex');
  for (const [mimeType, bytes] of [
    ['image/jpeg', jpeg], ['image/png', png()], ['image/gif', gif], ['image/webp', webp],
    ['image/bmp', bmp], ['image/heic', heic], ['image/heif', heif],
  ]) assert.equal(validateImage(image(mimeType, bytes)).ok, true, mimeType);
  assert.equal(validateImage(image('image/jpeg', png())).ok, false);
  assert.equal(validateImage(image('image/svg+xml', Buffer.from('<svg/>'))).ok, false);
  assert.equal(validateImage({ mimeType: 'image/png', data: '' }).ok, false);
  assert.equal(validateImage({ mimeType: 'image/png', data: '%%%=' }).ok, false);
  assert.equal(validateImage(image('image/png', Buffer.alloc(8 * 1024 * 1024 + 1))).ok, false);
});

test('image validation accepts base64 across chunk boundaries and rejects misplaced padding', () => {
  for (const size of [3072, 3073, 6144, 6145, 50000]) {
    const bytes = Buffer.alloc(size);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(bytes);
    bytes[bytes.length - 2] = 0xff;
    bytes[bytes.length - 1] = 0xd9;
    const input = image('image/jpeg', bytes);
    assert.equal(validateImage(input).ok, true, `JPEG with ${size} bytes`);
    for (const invalid of ['%', '=', '\n']) {
      const data = input.data.slice(0, 20) + invalid + input.data.slice(21);
      assert.equal(validateImage({ ...input, data }).ok, false, `invalid ${JSON.stringify(invalid)}`);
    }
  }
});
