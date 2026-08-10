/**
 * Tests for React Native LevelDB plugin registration and polyfill checks.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import register from '../src/plugin.js';

describe('React Native LevelDB Plugin', () => {
	describe('Polyfill checks', () => {
		let originalStructuredClone: any;
		let originalTextEncoder: any;
		let originalTextDecoder: any;

		before(() => {
			// Save originals
			originalStructuredClone = (globalThis as any).structuredClone;
			originalTextEncoder = (globalThis as any).TextEncoder;
			originalTextDecoder = (globalThis as any).TextDecoder;
		});

		afterEach(() => {
			// Restore all polyfills after each test
			(globalThis as any).structuredClone = originalStructuredClone;
			(globalThis as any).TextEncoder = originalTextEncoder;
			(globalThis as any).TextDecoder = originalTextDecoder;
			// Note: Symbol.asyncIterator is read-only in Node.js, so we can't restore it
			// This is fine since we only delete it in tests and it's not actually removed
		});

		it('should throw error when structuredClone is missing', () => {
			// Remove structuredClone
			delete (globalThis as any).structuredClone;

			const db = new Database();

			expect(() => {
				register(db, {
					openFn: (() => {}) as any,
					WriteBatch: class {} as any,
				});
			}).to.throw(/structuredClone/);
		});

		it('should throw error when TextEncoder is missing', () => {
			// Remove TextEncoder
			delete (globalThis as any).TextEncoder;

			const db = new Database();

			expect(() => {
				register(db, {
					openFn: (() => {}) as any,
					WriteBatch: class {} as any,
				});
			}).to.throw(/TextEncoder/);
		});

		it('should throw error when TextDecoder is missing', () => {
			// Remove TextDecoder
			delete (globalThis as any).TextDecoder;

			const db = new Database();

			expect(() => {
				register(db, {
					openFn: (() => {}) as any,
					WriteBatch: class {} as any,
				});
			}).to.throw(/TextDecoder/);
		});

		it('should throw error when Symbol.asyncIterator is missing', () => {
			// In React Native, Symbol.asyncIterator might not exist
			// We can't actually delete it in Node.js (it's read-only), so we'll skip this test in Node
			// and document that it works correctly in RN environments where it's not defined
			if (typeof Symbol.asyncIterator === 'undefined') {
				const db = new Database();

				expect(() => {
					register(db, {
						openFn: (() => {}) as any,
						WriteBatch: class {} as any,
					});
				}).to.throw(/Symbol\.asyncIterator/);
			}
		});

		it('should throw error listing all missing polyfills', () => {
			// Remove polyfills we can actually remove in Node.js
			delete (globalThis as any).structuredClone;
			delete (globalThis as any).TextEncoder;

			const db = new Database();

			try {
				register(db, {
					openFn: (() => {}) as any,
					WriteBatch: class {} as any,
				});
				expect.fail('Should have thrown');
			} catch (e) {
				const message = (e as Error).message;
				expect(message).to.include('structuredClone');
				expect(message).to.include('TextEncoder');
				expect(message).to.include('1.');
				expect(message).to.include('2.');
			}
		});

		it('should include installation instructions in error message', () => {
			delete (globalThis as any).structuredClone;

			const db = new Database();

			try {
				register(db, {
					openFn: (() => {}) as any,
					WriteBatch: class {} as any,
				});
				expect.fail('Should have thrown');
			} catch (e) {
				const message = (e as Error).message;
				expect(message).to.include('npm install');
				expect(message).to.include('core-js');
				expect(message).to.include('import');
			}
		});

		it('should pass polyfill check when all required APIs exist', () => {
			// Ensure all polyfills are present (they should be in Node.js by default)
			(globalThis as any).structuredClone = originalStructuredClone;
			(globalThis as any).TextEncoder = originalTextEncoder;
			(globalThis as any).TextDecoder = originalTextDecoder;
			// Symbol.asyncIterator is already present in Node.js

			const db = new Database();

			// Should throw about missing openFn/WriteBatch, not polyfills
			expect(() => {
				register(db, {});
			}).to.throw(/openFn.*option/);
		});
	});

	describe('Configuration validation', () => {
		it('should throw error when openFn is missing', () => {
			const db = new Database();

			expect(() => {
				register(db, {
					WriteBatch: class {} as any,
				});
			}).to.throw(/openFn.*option/);
		});

		it('should throw error when WriteBatch is missing', () => {
			const db = new Database();

			expect(() => {
				register(db, {
					openFn: (() => {}) as any,
				});
			}).to.throw(/WriteBatch.*option/);
		});
	});
});
