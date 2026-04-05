import test from 'node:test';
import assert from 'node:assert/strict';
import { greet, greetAll } from '../src/index.js';
test('greet returns a greeting for a single name', () => {
    assert.equal(greet('Jack'), 'Hello, Jack!');
});
test('greetAll returns greetings for multiple names', () => {
    assert.deepEqual(greetAll(['Jack', 'Code']), ['Hello, Jack!', 'Hello, Code!']);
});
