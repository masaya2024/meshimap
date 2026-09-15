import { createLogger } from './logger';

describe('createLogger', () => {
  it('開発時は debug を出力する', () => {
    const sink = jest.fn();
    const logger = createLogger({ isDevelopment: true, sink });

    logger.debug('地図を再検索する', { radiusM: 1000 });

    expect(sink).toHaveBeenCalledWith('debug', '地図を再検索する', { radiusM: 1000 });
  });

  it('本番では debug を出力しない', () => {
    const sink = jest.fn();
    const logger = createLogger({ isDevelopment: false, sink });

    logger.debug('地図を再検索する');

    expect(sink).not.toHaveBeenCalled();
  });

  it('本番でも error は出力する', () => {
    const sink = jest.fn();
    const logger = createLogger({ isDevelopment: false, sink });

    logger.error('店舗の取得に失敗した', { shopId: 'shp_1' });

    expect(sink).toHaveBeenCalledWith('error', '店舗の取得に失敗した', { shopId: 'shp_1' });
  });
});
