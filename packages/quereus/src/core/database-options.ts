/**
 * Centralized database options management with event-driven updates
 */

import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { SqlValue } from '../common/types.js';

const log = createLogger('core:options');

export type OptionValue = boolean | string | number | Record<string, SqlValue>;
export type OptionType = 'boolean' | 'string' | 'number' | 'object';

export interface OptionDefinition {
	type: OptionType;
	defaultValue: OptionValue;
	aliases?: string[];
	description?: string;
	onChange?: OptionChangeListener;
}

export interface OptionChangeEvent {
	key: string;
	oldValue: OptionValue;
	newValue: OptionValue;
}

export type OptionChangeListener = (event: OptionChangeEvent) => void;

/**
 * Centralized options manager with event notifications and registration
 */
export class DatabaseOptionsManager {
	private options = new Map<string, OptionValue>();
	private definitions = new Map<string, OptionDefinition>();
	private aliases = new Map<string, string>(); // alias -> canonical key

	/**
	 * Register an option with its definition
	 */
	registerOption(key: string, definition: OptionDefinition): void {
		if (this.definitions.has(key)) {
			throw new QuereusError(`Option ${key} is already registered`, StatusCode.INTERNAL);
		}

		this.definitions.set(key, definition);
		this.options.set(key, definition.defaultValue);

		// Register aliases
		if (definition.aliases) {
			for (const alias of definition.aliases) {
				if (this.aliases.has(alias.toLowerCase())) {
					throw new QuereusError(`Option alias ${alias} is already registered`, StatusCode.INTERNAL);
				}
				this.aliases.set(alias.toLowerCase(), key);
			}
		}

		log('Registered option %s (type: %s, default: %j)', key, definition.type, definition.defaultValue);
	}

	/**
	 * Set an option value and notify listeners
	 */
	setOption(key: string, value: unknown): void {
		const canonicalKey = this.resolveKey(key);
		if (!canonicalKey) {
			throw new QuereusError(`Unknown option: ${key}`, StatusCode.ERROR);
		}

		const definition = this.definitions.get(canonicalKey)!;
		const convertedValue = this.convertValue(value, definition, key);
		const oldValue = this.options.get(canonicalKey)!;

		if (this.valuesEqual(oldValue, convertedValue)) {
			return; // No change
		}

		this.options.set(canonicalKey, convertedValue);

		// Notify listener if registered — roll back on failure
		try {
			this.notifyListener(canonicalKey, oldValue, convertedValue);
		} catch (error) {
			this.options.set(canonicalKey, oldValue);
			throw error;
		}

		log('Option %s changed: %j → %j', canonicalKey, oldValue, convertedValue);
	}

	/**
	 * Get an option value
	 */
	getOption(key: string): OptionValue {
		const canonicalKey = this.resolveKey(key);
		if (!canonicalKey) {
			throw new QuereusError(`Unknown option: ${key}`, StatusCode.ERROR);
		}

		return this.options.get(canonicalKey)!;
	}

	/**
	 * Get a boolean option value with type safety
	 */
	getBooleanOption(key: string): boolean {
		const value = this.getOption(key);
		if (typeof value !== 'boolean') {
			throw new QuereusError(`Option ${key} is not a boolean (got ${typeof value})`, StatusCode.INTERNAL);
		}
		return value;
	}

	/**
	 * Get a string option value with type safety
	 */
	getStringOption(key: string): string {
		const value = this.getOption(key);
		if (typeof value !== 'string') {
			throw new QuereusError(`Option ${key} is not a string (got ${typeof value})`, StatusCode.INTERNAL);
		}
		return value;
	}

	/**
	 * Get a number option value with type safety
	 */
	getNumberOption(key: string): number {
		const value = this.getOption(key);
		if (typeof value !== 'number') {
			throw new QuereusError(`Option ${key} is not a number (got ${typeof value})`, StatusCode.INTERNAL);
		}
		return value;
	}

	/**
	 * Get an object option value with type safety
	 */
	getObjectOption(key: string): Record<string, SqlValue> {
		const value = this.getOption(key);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new QuereusError(`Option ${key} is not an object (got ${typeof value})`, StatusCode.INTERNAL);
		}
		return value as Record<string, SqlValue>;
	}



	/**
	 * Get all current options
	 */
	getAllOptions(): Record<string, OptionValue> {
		const result: Record<string, OptionValue> = {};
		for (const [key, value] of this.options) {
			result[key] = value;
		}
		return result;
	}

	/**
	 * Get all registered option definitions
	 */
	getOptionDefinitions(): Record<string, OptionDefinition> {
		const result: Record<string, OptionDefinition> = {};
		for (const [key, definition] of this.definitions) {
			result[key] = { ...definition };
		}
		return result;
	}

	private resolveKey(key: string): string | null {
		const lowerKey = key.toLowerCase();

		// Check if it's an alias
		const aliasTarget = this.aliases.get(lowerKey);
		if (aliasTarget) {
			return aliasTarget;
		}

		// Check if it's a direct key
		for (const registeredKey of this.definitions.keys()) {
			if (registeredKey.toLowerCase() === lowerKey) {
				return registeredKey;
			}
		}

		return null;
	}

	private convertValue(value: unknown, definition: OptionDefinition, originalKey: string): OptionValue {
		switch (definition.type) {
			case 'boolean':
				return this.convertToBoolean(value, originalKey);
			case 'string':
				return String(value);
			case 'number':
				return this.convertToNumber(value, originalKey);
			case 'object':
				return this.convertToObject(value, originalKey);
			default:
				throw new QuereusError(`Unknown option type: ${definition.type}`, StatusCode.INTERNAL);
		}
	}

	private convertToBoolean(value: unknown, key: string): boolean {
		if (typeof value === 'boolean') {
			return value;
		}
		if (typeof value === 'string') {
			const lower = value.toLowerCase();
			if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') {
				return true;
			}
			if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') {
				return false;
			}
		}
		if (typeof value === 'number') {
			return value !== 0;
		}
		throw new QuereusError(`Invalid boolean value for option ${key}: ${value}`, StatusCode.ERROR);
	}

	private convertToNumber(value: unknown, key: string): number {
		if (typeof value === 'number') {
			return value;
		}
		if (typeof value === 'string') {
			const num = Number(value);
			if (!isNaN(num)) {
				return num;
			}
		}
		throw new QuereusError(`Invalid number value for option ${key}: ${value}`, StatusCode.ERROR);
	}

	private convertToObject(value: unknown, key: string): Record<string, SqlValue> {
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			return value as Record<string, SqlValue>;
		}
		if (typeof value === 'string') {
			try {
				const parsed = JSON.parse(value);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					return parsed;
				}
			} catch {
				// Fall through to error
			}
		}
		throw new QuereusError(`Invalid object value for option ${key}: ${value}`, StatusCode.ERROR);
	}

	private valuesEqual(a: OptionValue, b: OptionValue): boolean {
		if (a === b) return true;
		if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
			return JSON.stringify(a) === JSON.stringify(b);
		}
		return false;
	}

	private notifyListener(key: string, oldValue: OptionValue, newValue: OptionValue): void {
		const definition = this.definitions.get(key);
		if (definition?.onChange) {
			const event: OptionChangeEvent = { key, oldValue, newValue };
			definition.onChange(event);
		}
	}
}
