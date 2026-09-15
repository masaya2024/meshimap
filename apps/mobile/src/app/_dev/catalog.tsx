import { MapPin, Star } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button, type ButtonVariant } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** Button の全 variant。型から漏れなく並べるため as const で固定する */
const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'danger',
] as const;

/** Badge の全 tone */
const BADGE_TONES: readonly BadgeTone[] = [
  'neutral',
  'success',
  'warning',
  'danger',
  'brand',
] as const;

/** Skeleton の見本に使う寸法。カード画像・本文行・アバターの 3 用途を再現する */
const SKELETON_IMAGE_HEIGHT = 160;
const SKELETON_TEXT_HEIGHT = 16;
const SKELETON_AVATAR_SIZE = 48;

/** カタログでは操作結果を見せないので、押下ハンドラは意図的に何もしない */
const noop = (): void => {};

interface SectionProps {
  title: string;
  children: ReactNode;
}

/** 見出しと区切り線を共通化する。カタログ内でしか使わないのでこのファイルに閉じる */
function Section({ title, children }: SectionProps) {
  return (
    <View className="gap-sm border-b border-neutral-200 py-lg">
      <Text className="font-display text-lg text-neutral-900">{title}</Text>
      {children}
    </View>
  );
}

/**
 * UI プリミティブの見本市。variant / size / 状態を一覧で見比べて
 * デザインの一貫性を確認する場所。プリミティブを足したらここにも追加する。
 */
export default function CatalogScreen() {
  return (
    <ScrollView className="flex-1 bg-white px-md">
      <Section title="Button">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} label={variant} variant={variant} onPress={noop} />
        ))}
        <Button label="読み込み中" onPress={noop} isLoading />
        <Button label="無効" onPress={noop} isDisabled />
      </Section>

      <Section title="Badge">
        <View className="flex-row flex-wrap gap-sm">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} label={tone} tone={tone} />
          ))}
        </View>
      </Section>

      <Section title="Card">
        <Card>
          <Text className="font-body text-neutral-800">押せないカード</Text>
        </Card>
        <Card onPress={noop}>
          <Text className="font-body text-neutral-800">押せるカード</Text>
        </Card>
      </Section>

      <Section title="Input">
        <Input
          label="店名"
          value=""
          onChangeText={noop}
          placeholder="例: 炭火焼鳥 とり源"
          isRequired
        />
        <Input
          label="電話番号"
          value="03-"
          onChangeText={noop}
          errorMessage="電話番号の形式が正しくありません"
        />
      </Section>

      <Section title="Skeleton">
        <Skeleton height={SKELETON_IMAGE_HEIGHT} />
        <Skeleton height={SKELETON_TEXT_HEIGHT} width="60%" shape="text" />
        <Skeleton height={SKELETON_AVATAR_SIZE} width={SKELETON_AVATAR_SIZE} shape="circle" />
      </Section>

      <Section title="Icon">
        <View className="flex-row items-center gap-sm">
          <Icon icon={MapPin} size="sm" />
          <Icon icon={MapPin} size="md" />
          <Icon icon={Star} size="lg" />
        </View>
      </Section>

      <Section title="EmptyState">
        <EmptyState
          icon={MapPin}
          title="この条件のお店は見つかりませんでした"
          description="範囲を広げるか、条件を減らしてみてください。"
          action={{ label: '条件をリセット', onPress: noop }}
        />
      </Section>

      <Section title="ErrorState">
        <ErrorState onRetry={noop} />
      </Section>
    </ScrollView>
  );
}
