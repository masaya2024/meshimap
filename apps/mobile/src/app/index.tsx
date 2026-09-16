import { Text, View } from 'react-native';

/** Phase 6 Task 6-1 で地図画面に差し替えるプレースホルダー */
export default function HomeScreen() {
  return (
    <View className="flex-1 items-center justify-center gap-sm bg-neutral-50">
      <Text className="font-body-bold text-xxl text-neutral-900">メシマップ</Text>
      <Text className="font-body text-base text-neutral-600">地図から、いま行ける店を見つける</Text>
    </View>
  );
}
