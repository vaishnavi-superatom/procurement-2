import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

type ColorPickerSize = 'xs' | 'sm' | 'md' | 'lg';
type ColorFormat = 'hex' | 'rgb' | 'hsl';

interface ColorPickerProps {
  size?: ColorPickerSize;
  format?: ColorFormat;
  label?: string;
  labelInline?: boolean;
  labelWidth?: string;
  placeholder?: string;
  helperText?: string;
  error?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (color: string) => void;
  onChangeComplete?: (color: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  presetColors?: string[];
  showPresets?: boolean;
  showInput?: boolean;
  showAlpha?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-colorpicker',
  name: 'ColorPicker',
  displayName: 'Color picker input',
  isDisplayComp: true,
  type: 'ColorPicker',
  description: 'A color picker component with gradient selector and preset swatches using DaisyUI. Supports hex, RGB, and HSL formats.',
  category: 'input',
  keywords: ['color', 'picker', 'palette', 'input', 'form', 'hex', 'rgb', 'hsl'],
  props: {
    size: '"xs" | "sm" | "md" (default) | "lg"',
    format: '"hex" (default) | "rgb" | "hsl"',
    label: 'Label text',
    labelInline: 'Show label inline with input (default: false)',
    placeholder: 'Placeholder text',
    helperText: 'Helper text below input',
    error: 'Error message',
    value: 'Selected color (controlled)',
    defaultValue: 'Default color (uncontrolled)',
    onChange: 'Callback when color changes (during drag)',
    onChangeComplete: 'Callback when color selection is complete (on release)',
    onOpen: 'Callback when picker opens',
    onClose: 'Callback when picker closes',
    presetColors: 'Array of preset color swatches',
    showPresets: 'Show preset color swatches (default: true)',
    showInput: 'Show color value input (default: true)',
    showAlpha: 'Show alpha/opacity slider (default: false)',
    disabled: 'Disable the input',
  },
};

const DEFAULT_PRESETS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#78716c',
  '#000000', '#ffffff',
];

interface HSL {
  h: number;
  s: number;
  l: number;
  a: number;
}

interface ColorPickerComponent extends React.FC<ColorPickerProps> {
  Metadata: ComponentMetadata;
}

// Color conversion utilities
const hexToHsl = (hex: string): HSL => {
  let r = 0, g = 0, b = 0, a = 1;

  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255;
    g = parseInt(hex[2] + hex[2], 16) / 255;
    b = parseInt(hex[3] + hex[3], 16) / 255;
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16) / 255;
    g = parseInt(hex.slice(3, 5), 16) / 255;
    b = parseInt(hex.slice(5, 7), 16) / 255;
  } else if (hex.length === 9) {
    r = parseInt(hex.slice(1, 3), 16) / 255;
    g = parseInt(hex.slice(3, 5), 16) / 255;
    b = parseInt(hex.slice(5, 7), 16) / 255;
    a = parseInt(hex.slice(7, 9), 16) / 255;
  }

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h: h * 360, s: s * 100, l: l * 100, a };
};

const hslToHex = (hsl: HSL): string => {
  const { h, s, l, a } = hsl;
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lNorm - c / 2;

  let r = 0, g = 0, b = 0;

  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');

  let hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  if (a < 1) {
    hex += Math.round(a * 255).toString(16).padStart(2, '0');
  }

  return hex;
};

const hslToRgb = (hsl: HSL): string => {
  const { h, s, l, a } = hsl;
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lNorm - c / 2;

  let r = 0, g = 0, b = 0;

  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  const rVal = Math.round((r + m) * 255);
  const gVal = Math.round((g + m) * 255);
  const bVal = Math.round((b + m) * 255);

  if (a < 1) {
    return `rgba(${rVal}, ${gVal}, ${bVal}, ${a.toFixed(2)})`;
  }
  return `rgb(${rVal}, ${gVal}, ${bVal})`;
};

const hslToHslString = (hsl: HSL): string => {
  const { h, s, l, a } = hsl;
  if (a < 1) {
    return `hsla(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%, ${a.toFixed(2)})`;
  }
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
};

const parseColor = (color: string): HSL => {
  if (color.startsWith('#')) {
    return hexToHsl(color);
  }
  if (color.startsWith('rgb')) {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (match) {
      const r = parseInt(match[1]) / 255;
      const g = parseInt(match[2]) / 255;
      const b = parseInt(match[3]) / 255;
      const a = match[4] ? parseFloat(match[4]) : 1;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let h = 0, s = 0;
      const l = (max + min) / 2;

      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
          case g: h = ((b - r) / d + 2) / 6; break;
          case b: h = ((r - g) / d + 4) / 6; break;
        }
      }

      return { h: h * 360, s: s * 100, l: l * 100, a };
    }
  }
  if (color.startsWith('hsl')) {
    const match = color.match(/hsla?\((\d+),\s*([\d.]+)%,\s*([\d.]+)%(?:,\s*([\d.]+))?\)/);
    if (match) {
      return {
        h: parseInt(match[1]),
        s: parseFloat(match[2]),
        l: parseFloat(match[3]),
        a: match[4] ? parseFloat(match[4]) : 1,
      };
    }
  }
  return { h: 0, s: 100, l: 50, a: 1 };
};

const ColorPicker: ColorPickerComponent = ({
  size = 'md',
  format = 'hex',
  label,
  labelInline = false,
  labelWidth = 'w-24',
  placeholder = 'Select color...',
  helperText,
  error,
  value,
  defaultValue = '#3b82f6',
  onChange,
  onChangeComplete,
  onOpen,
  onClose,
  presetColors = DEFAULT_PRESETS,
  showPresets = true,
  showInput = true,
  showAlpha = false,
  disabled = false,
  className = '',
  id,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [internalHsl, setInternalHsl] = useState<HSL>(() => parseColor(value ?? defaultValue));
  const [inputValue, setInputValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const saturationRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const alphaRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef<'saturation' | 'hue' | 'alpha' | null>(null);

  // Update internal state when controlled value changes
  useEffect(() => {
    if (value !== undefined) {
      setInternalHsl(parseColor(value));
    }
  }, [value]);

  // Format color for output
  const formatColor = useCallback((hsl: HSL): string => {
    switch (format) {
      case 'rgb': return hslToRgb(hsl);
      case 'hsl': return hslToHslString(hsl);
      default: return hslToHex(hsl);
    }
  }, [format]);

  // Update input value when color changes
  useEffect(() => {
    setInputValue(formatColor(internalHsl));
  }, [internalHsl, formatColor]);

  // Size classes
  const sizeClasses: Record<ColorPickerSize, string> = {
    xs: 'input-xs text-xs',
    sm: 'input-sm text-sm',
    md: '',
    lg: 'input-lg text-lg',
  };

  const swatchSizes: Record<ColorPickerSize, string> = {
    xs: 'w-4 h-4',
    sm: 'w-5 h-5',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  const previewSizes: Record<ColorPickerSize, string> = {
    xs: 'w-6 h-6',
    sm: 'w-7 h-7',
    md: 'w-8 h-8',
    lg: 'w-10 h-10',
  };

  // Handle open/close
  const handleOpen = () => {
    if (!disabled) {
      setIsOpen(true);
      onOpen?.();
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    onClose?.();
    onChangeComplete?.(formatColor(internalHsl));
  };

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        handleClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [internalHsl]);

  // Update color and notify
  const updateColor = useCallback((newHsl: HSL, complete = false) => {
    setInternalHsl(newHsl);
    const colorString = formatColor(newHsl);
    onChange?.(colorString);
    if (complete) {
      onChangeComplete?.(colorString);
    }
  }, [formatColor, onChange, onChangeComplete]);

  // Saturation/Lightness picker handlers
  const handleSaturationMove = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!saturationRef.current) return;
    const rect = saturationRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    // Convert x,y to saturation and lightness
    const s = x * 100;
    const l = (1 - y) * 50 + (1 - x) * (1 - y) * 50;

    updateColor({ ...internalHsl, s, l });
  }, [internalHsl, updateColor]);

  // Hue picker handlers
  const handleHueMove = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    updateColor({ ...internalHsl, h: x * 360 });
  }, [internalHsl, updateColor]);

  // Alpha picker handlers
  const handleAlphaMove = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!alphaRef.current) return;
    const rect = alphaRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    updateColor({ ...internalHsl, a: x });
  }, [internalHsl, updateColor]);

  // Mouse event handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging.current === 'saturation') handleSaturationMove(e);
      else if (isDragging.current === 'hue') handleHueMove(e);
      else if (isDragging.current === 'alpha') handleAlphaMove(e);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        onChangeComplete?.(formatColor(internalHsl));
        isDragging.current = null;
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleSaturationMove, handleHueMove, handleAlphaMove, formatColor, internalHsl, onChangeComplete]);

  // Handle preset click
  const handlePresetClick = (color: string) => {
    const hsl = parseColor(color);
    updateColor(hsl, true);
  };

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    try {
      const hsl = parseColor(newValue);
      updateColor(hsl);
    } catch {
      // Invalid color format, ignore
    }
  };

  const handleInputBlur = () => {
    onChangeComplete?.(formatColor(internalHsl));
  };

  const inputClasses = [
    'input',
    'input-bordered',
    'w-full',
    'cursor-pointer',
    'bg-base-100',
    sizeClasses[size],
    error ? 'input-error' : '',
    className,
  ].filter(Boolean).join(' ');

  // Calculate saturation picker position
  const satX = internalHsl.s / 100;
  const satY = 1 - (internalHsl.l / 50 - (1 - satX) * (1 - internalHsl.l / 50));

  const pickerContent = (
    <div className="p-3 bg-base-100 rounded-lg shadow-xl border border-base-300 w-64">
      {/* Saturation/Lightness Picker */}
      <div
        ref={saturationRef}
        className="w-full h-40 rounded-lg relative cursor-crosshair mb-3"
        style={{
          background: `linear-gradient(to bottom, transparent, #000),
                       linear-gradient(to right, #fff, hsl(${internalHsl.h}, 100%, 50%))`,
        }}
        onMouseDown={(e) => {
          isDragging.current = 'saturation';
          handleSaturationMove(e);
        }}
      >
        <div
          className="absolute w-4 h-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{
            left: `${satX * 100}%`,
            top: `${Math.max(0, Math.min(1, satY)) * 100}%`,
            backgroundColor: hslToHex(internalHsl),
          }}
        />
      </div>

      {/* Hue Slider */}
      <div
        ref={hueRef}
        className="w-full h-3 rounded-full relative cursor-pointer mb-3"
        style={{
          background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
        }}
        onMouseDown={(e) => {
          isDragging.current = 'hue';
          handleHueMove(e);
        }}
      >
        <div
          className="absolute w-4 h-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{
            left: `${(internalHsl.h / 360) * 100}%`,
            backgroundColor: `hsl(${internalHsl.h}, 100%, 50%)`,
          }}
        />
      </div>

      {/* Alpha Slider */}
      {showAlpha && (
        <div
          ref={alphaRef}
          className="w-full h-3 rounded-full relative cursor-pointer mb-3"
          style={{
            background: `linear-gradient(to right, transparent, ${hslToHex({ ...internalHsl, a: 1 })}),
                         repeating-conic-gradient(#808080 0% 25%, #fff 0% 50%) 50% / 8px 8px`,
          }}
          onMouseDown={(e) => {
            isDragging.current = 'alpha';
            handleAlphaMove(e);
          }}
        >
          <div
            className="absolute w-4 h-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{
              left: `${internalHsl.a * 100}%`,
              backgroundColor: hslToHex(internalHsl),
            }}
          />
        </div>
      )}

      {/* Color Input */}
      {showInput && (
        <div className="mb-3">
          <input
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            className="input input-bordered input-sm w-full font-mono text-xs"
            placeholder={format === 'hex' ? '#000000' : format === 'rgb' ? 'rgb(0,0,0)' : 'hsl(0,0%,0%)'}
          />
        </div>
      )}

      {/* Preset Colors */}
      {showPresets && presetColors.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-base-300">
          {presetColors.map((color, index) => (
            <button
              key={index}
              type="button"
              onClick={() => handlePresetClick(color)}
              className={`${swatchSizes[size]} rounded border border-base-300 hover:scale-110 transition-transform`}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
        </div>
      )}
    </div>
  );

  // Preview size in pixels based on component size
  const previewPx: Record<ColorPickerSize, number> = {
    xs: 20,
    sm: 24,
    md: 28,
    lg: 36,
  };

  const currentPreviewSize = previewPx[size];
  const currentHexColor = hslToHex(internalHsl);

  const inputField = (
    <div className={`relative ${labelInline ? 'flex-1' : ''}`} ref={containerRef}>
      {/* Input with color swatch */}
      <div className="relative flex items-center">
        {/* Color Preview Swatch - positioned inside input */}
        <div
          onClick={handleOpen}
          className="absolute left-2 z-10 rounded border-2 border-base-300 cursor-pointer shadow-sm hover:scale-105 transition-transform"
          style={{
            width: currentPreviewSize,
            height: currentPreviewSize,
            backgroundColor: currentHexColor,
            top: '50%',
            transform: 'translateY(-50%)',
          }}
        />

        <input
          id={id}
          type="text"
          readOnly
          disabled={disabled}
          placeholder={placeholder}
          value={formatColor(internalHsl)}
          onClick={handleOpen}
          className={inputClasses}
          style={{ paddingLeft: currentPreviewSize + 20 }}
        />
      </div>

      {/* Color Picker Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 left-0">
          {pickerContent}
        </div>
      )}

      {/* Helper/Error Text */}
      {(helperText || error) && (
        <label className="label py-1">
          <span className={`label-text-alt ${error ? 'text-error' : ''}`}>
            {error || helperText}
          </span>
        </label>
      )}
    </div>
  );

  // Inline layout
  if (labelInline && label) {
    return (
      <div className="flex items-start gap-3 w-full">
        <label className={`label-text flex-shrink-0 ${labelWidth} pt-3`} htmlFor={id}>
          {label}
        </label>
        {inputField}
      </div>
    );
  }

  // Stacked layout
  return (
    <div className="form-control w-full">
      {label && (
        <label className="label py-1" htmlFor={id}>
          <span className="label-text">{label}</span>
        </label>
      )}
      {inputField}
    </div>
  );
};

ColorPicker.Metadata = METADATA;

export default ColorPicker;
