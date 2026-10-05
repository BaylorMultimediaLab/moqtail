import { describe, it, expect } from 'vitest';
import { controllerArmParam } from './runParams';

describe('controllerArmParam (?controllerArm=)', () => {
  it('accepts the three arms', () => {
    expect(controllerArmParam('min')).toBe('min');
    expect(controllerArmParam('grid')).toBe('grid');
    expect(controllerArmParam('baseline')).toBe('baseline');
  });

  it('ignores anything else', () => {
    expect(controllerArmParam(null)).toBeNull();
    expect(controllerArmParam('')).toBeNull();
    expect(controllerArmParam('MIN')).toBeNull();
    expect(controllerArmParam('fast')).toBeNull();
  });
});
