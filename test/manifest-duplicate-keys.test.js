'use strict';

// app.json is edited by hand. JSON.parse keeps the last of two equal keys without a word, so a
// second "hint" inserted into a settings row would hide the first, and Homey, the validator and
// every test would all read the survivor. Found while rewriting tooltips in 1.2.285: a patch that
// took a dropdown's first value for the end of the row put a second hint in front of the list.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

function duplicateKeys(text) {
  let i = 0;
  const stack = [];
  const dups = [];
  const readString = () => {
    let j = i + 1;
    let out = '';
    while (text[j] !== '"') {
      if (text[j] === '\\') { out += text[j] + text[j + 1]; j += 2; } else out += text[j++];
    }
    i = j + 1;
    return out;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const key = readString();
      let k = i;
      while (/\s/.test(text[k])) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top && top.keys) {
        if (top.keys.has(key)) dups.push(`"${key}" on line ${text.slice(0, i).split('\n').length}`);
        top.keys.add(key);
      }
      continue;
    }
    if (c === '{') stack.push({ keys: new Set() });
    else if (c === '[') stack.push({});
    else if (c === '}' || c === ']') stack.pop();
    i++;
  }
  return dups;
}

test('the scanner finds a duplicate key, and only a real one', () => {
  assert.deepStrictEqual(duplicateKeys('{"a": 1, "b": {"a": 2}, "c": ["a", "a"]}'), []);
  assert.deepStrictEqual(duplicateKeys('{"hint": {"en": "x"},\n "hint": {"en": "y \\" hint"}}'), ['"hint" on line 2']);
});

test('app.json has no key twice in the same object', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8');
  assert.deepStrictEqual(duplicateKeys(text), []);
});
