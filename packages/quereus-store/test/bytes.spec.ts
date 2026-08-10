/**
 * Guards the byte→hex encoding contract the whole store depends on.
 *
 * `bytesToHex` is the single home for hex-encoding storage keys (the coordinator
 * index, `CachedKVStore`, and `InMemoryKVStore` all route through it). Its output
 * MUST be lowercase, zero-padded, exactly two chars per byte: `InMemoryKVStore`
 * orders keys by string comparison, and `[0-9a-f]` is the only alphabet where that
 * matches unsigned-byte order (see `memory-store.ts` `compareHex`). Uppercase or
 * unpadded output would silently mis-order every store test's oracle.
 */

import { expect } from 'chai';
import { bytesToHex, compareBytes } from '../src/common/bytes.js';

describe('bytesToHex', () => {
	it('emits lowercase, zero-padded, two chars per byte', () => {
		expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xa0, 0xff]))).to.equal('000fa0ff');
	});

	it('encodes the empty array to the empty string', () => {
		expect(bytesToHex(new Uint8Array([]))).to.equal('');
	});

	it('covers every byte value 0x00–0xff with two lowercase hex chars', () => {
		const all = new Uint8Array(256);
		for (let b = 0; b < 256; b++) all[b] = b;
		const hex = bytesToHex(all);
		expect(hex).to.have.length(512);
		expect(hex).to.match(/^[0-9a-f]+$/);
		// Spot-check the padding boundary and the top of the range.
		expect(hex.slice(0, 4)).to.equal('0001');
		expect(hex.slice(30, 34)).to.equal('0f10'); // byte 15 → '0f', byte 16 → '10'
		expect(hex.slice(510, 512)).to.equal('ff');
	});

	it('string order of the hex output matches unsigned-byte order', () => {
		// The ordering invariant InMemoryKVStore relies on: for any two keys, the
		// lexicographic order of their hex encodings equals compareBytes' sign.
		const samples = [
			new Uint8Array([]),
			new Uint8Array([0x00]),
			new Uint8Array([0x00, 0x00]),
			new Uint8Array([0x0f]),
			new Uint8Array([0x10]),
			new Uint8Array([0x7f]),
			new Uint8Array([0x80]),
			new Uint8Array([0xff]),
			new Uint8Array([0xff, 0x00]),
		];
		for (const a of samples) {
			for (const b of samples) {
				const byteCmp = Math.sign(compareBytes(a, b));
				const hexCmp = Math.sign(bytesToHex(a).localeCompare(bytesToHex(b)));
				expect(hexCmp).to.equal(byteCmp, `${bytesToHex(a)} vs ${bytesToHex(b)}`);
			}
		}
	});
});
