import { ValidationError } from './errors.js';

const FUNCTIONS = {
    min: Math.min,
    max: Math.max,
    round: (x) => Math.round(x),
    floor: Math.floor,
    ceil: Math.ceil,
    abs: Math.abs,
    sqrt: Math.sqrt,
    pow: Math.pow,
    clamp: (x, min, max) => Math.min(max, Math.max(min, x)),
};

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[+\-*/%^(),]))/y;

function tokenize(expression) {
    const tokens = [];
    let index = 0;
    const source = String(expression ?? '');
    while (index < source.length) {
        if (/\s/.test(source[index])) {
            index += 1;
            continue;
        }
        TOKEN_RE.lastIndex = index;
        const match = TOKEN_RE.exec(source);
        if (!match) throw new Error(`Unexpected character at position ${index}`);
        index = TOKEN_RE.lastIndex;
        if (match[1]) tokens.push({ type: 'number', value: Number(match[1]) });
        else if (match[2]) tokens.push({ type: 'identifier', value: match[2] });
        else tokens.push({ type: 'operator', value: match[3] });
    }
    tokens.push({ type: 'eof', value: null });
    return tokens;
}

/**
 * Small, safe arithmetic expression evaluator. No eval/new Function.
 * Supports + - * / % ^, parentheses, numeric literals and a fixed function set.
 * @param {string} expression
 * @param {Record<string, number>} variables
 * @returns {number}
 */
export function evaluateFormula(expression, variables = {}) {
    if (typeof expression !== 'string' || !expression.trim()) {
        throw new ValidationError('Formula must be a non-empty string');
    }
    const tokens = tokenize(expression);
    let cursor = 0;
    const peek = () => tokens[cursor];
    const consume = (value) => {
        const token = tokens[cursor];
        if (value !== undefined && token.value !== value) {
            throw new Error(`Expected '${value}' but found '${token.value}'`);
        }
        cursor += 1;
        return token;
    };

    function primary() {
        const token = peek();
        if (token.type === 'number') {
            cursor += 1;
            return token.value;
        }
        if (token.type === 'identifier') {
            cursor += 1;
            if (peek().value === '(') {
                const fn = FUNCTIONS[token.value];
                if (!fn) throw new Error(`Unknown function '${token.value}'`);
                consume('(');
                const args = [];
                if (peek().value !== ')') {
                    args.push(expressionLevel());
                    while (peek().value === ',') {
                        consume(',');
                        args.push(expressionLevel());
                    }
                }
                consume(')');
                return fn(...args);
            }
            const rawValue = variables[token.value];
            if (rawValue === undefined) {
                throw new Error(`Unknown variable '${token.value}'`);
            }
            const value = Number(rawValue);
            if (!Number.isFinite(value)) throw new Error(`Variable '${token.value}' is not numeric`);
            return value;
        }
        if (token.value === '(') {
            consume('(');
            const value = expressionLevel();
            consume(')');
            return value;
        }
        if (token.value === '-') {
            consume('-');
            return -primary();
        }
        if (token.value === '+') {
            consume('+');
            return primary();
        }
        throw new Error(`Unexpected token '${token.value}'`);
    }

    function powerLevel() {
        let value = primary();
        while (peek().value === '^' || peek().value === '**') {
            cursor += 1;
            value = value ** primary();
        }
        return value;
    }

    function termLevel() {
        let value = powerLevel();
        while (['*', '/', '%'].includes(peek().value)) {
            const operator = consume().value;
            const right = powerLevel();
            if ((operator === '/' || operator === '%') && right === 0) throw new Error('Division by zero');
            if (operator === '*') value *= right;
            else if (operator === '/') value /= right;
            else value %= right;
        }
        return value;
    }

    function expressionLevel() {
        let value = termLevel();
        while (peek().value === '+' || peek().value === '-') {
            const operator = consume().value;
            const right = termLevel();
            value = operator === '+' ? value + right : value - right;
        }
        return value;
    }

    const result = expressionLevel();
    if (peek().type !== 'eof') throw new Error(`Unexpected token '${peek().value}'`);
    if (!Number.isFinite(result)) throw new Error('Formula result is not finite');
    return result;
}

export function validateFormula(expression) {
    try {
        const variables = new Proxy({}, {
            has: () => true,
            get: () => 1,
        });
        evaluateFormula(expression, variables);
        return { valid: true };
    } catch (error) {
        return { valid: false, message: error.message };
    }
}

export const DEFAULT_FORMULAS = {
    physicalDamage: 'max(1, round((atk * 1.6 + power) * (100 / (100 + def)) * variance * critMult * elementMult))',
    magicalDamage: 'max(1, round((mag * 1.7 + power) * (100 / (100 + res)) * variance * critMult * elementMult))',
    heal: 'max(1, round(mag * 1.4 + power))',
    hitChance: 'clamp(0.75 + (hit - evade) * 0.01, 0.05, 0.95)',
    critChance: 'clamp(0.05 + luck * 0.005, 0.01, 0.5)',
    fleeChance: 'clamp(0.5 + (agi - enemyAgi) * 0.01, 0.1, 0.9)',
    expToNext: 'round(20 * pow(level, 1.55))',
};
