import { Text, TextInput, View } from 'react-native';

import { COLORS } from '@/constants/theme';

export interface InputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string | undefined;
  errorMessage?: string | undefined;
  isRequired?: boolean | undefined;
  isMultiline?: boolean | undefined;
  maxLength?: number | undefined;
  testID?: string | undefined;
}

/** 枠線の色。エラー時だけ danger 色に切り替える */
const BORDER_STYLES = {
  default: 'border-neutral-300',
  error: 'border-red-500',
} as const;

/** 必須マークの文言。`*` だけでは読み上げで意味が伝わらないため文字で示す */
const REQUIRED_MARK_LABEL = '必須';

/** アクセシビリティラベルの区切り。読み上げで一拍置かせるため読点を使う */
const ACCESSIBILITY_LABEL_SEPARATOR = '、';

const ERROR_LABEL_PREFIX = 'エラー: ';

/** 複数行入力の最小の高さ（px）。3 行程度が収まる高さにする */
const MULTILINE_MIN_HEIGHT_PX = 96;

/**
 * React Native の AccessibilityProps には Web の `aria-invalid`（= `accessibilityInvalid`）に
 * 相当する prop が無く、AccessibilityState も disabled / selected / checked / busy / expanded の
 * 5 つしか持たない（node_modules/react-native/Libraries/Components/View/ViewAccessibility.d.ts）。
 * そのため「必須」「エラー」はアクセシビリティラベルに文言として載せ、
 * エラーメッセージ自体は accessibilityRole="alert" で読み上げ対象にする。
 */
function buildAccessibilityLabel(
  label: string,
  isRequired: boolean,
  errorMessage: string | undefined,
): string {
  const labelParts = [label];

  if (isRequired) {
    labelParts.push(REQUIRED_MARK_LABEL);
  }
  if (errorMessage !== undefined && errorMessage !== '') {
    labelParts.push(`${ERROR_LABEL_PREFIX}${errorMessage}`);
  }

  return labelParts.join(ACCESSIBILITY_LABEL_SEPARATOR);
}

export function Input({
  label,
  value,
  onChangeText,
  placeholder,
  errorMessage,
  isRequired = false,
  isMultiline = false,
  maxLength,
  testID,
}: InputProps) {
  const hasError = errorMessage !== undefined && errorMessage !== '';
  const hasCounter = maxLength !== undefined;

  return (
    <View className="gap-xs">
      <View className="flex-row items-center gap-xs">
        <Text className="font-body-medium text-sm text-neutral-700">{label}</Text>
        {isRequired ? (
          <Text className="rounded-full bg-red-50 px-xs py-px font-body-medium text-xs text-red-700">
            {REQUIRED_MARK_LABEL}
          </Text>
        ) : null}
      </View>

      <TextInput
        accessibilityLabel={buildAccessibilityLabel(label, isRequired, errorMessage)}
        className={[
          'rounded-card border bg-white px-md py-sm font-body text-base text-neutral-900',
          hasError ? BORDER_STYLES.error : BORDER_STYLES.default,
        ].join(' ')}
        maxLength={maxLength}
        multiline={isMultiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.neutral[400]}
        // 高さは MULTILINE_MIN_HEIGHT_PX と二重管理にしないよう className ではなく style で与える。
        // textAlignVertical は Android で入力が上端から始まるようにするため必要
        style={
          isMultiline ? { minHeight: MULTILINE_MIN_HEIGHT_PX, textAlignVertical: 'top' } : null
        }
        testID={testID}
        value={value}
      />

      {hasError || hasCounter ? (
        <View className="flex-row items-start gap-sm">
          {hasError ? (
            <Text accessibilityRole="alert" className="flex-1 font-body text-xs text-red-700">
              {errorMessage}
            </Text>
          ) : null}
          {hasCounter ? (
            <Text className="ml-auto font-body text-xs text-neutral-500">
              {`${value.length}/${maxLength}`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
