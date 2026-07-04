import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('workspace scaffold', () => {
  it('compiles and runs tests', () => {
    expect(PACKAGE_NAME).toBe('@merited/contracts');
  });
});
