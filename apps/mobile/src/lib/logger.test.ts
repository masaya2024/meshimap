import { createLogger, logger } from './logger';

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

/**
 * 既定の sink（consoleSink）はテストのためだけに export せず、公開済みの logger 越しに検証する。
 * console へ書くのはこのモジュールだけという取り決めを export で崩さずに済み、
 * __DEV__ と sink の結線まで含めて確かめられる。
 */
describe('logger（既定の console sink）', () => {
  /** console の出力でテストログを汚さないよう、握り潰したスパイに差し替える */
  function spyOnConsole() {
    return {
      error: jest.spyOn(console, 'error').mockImplementation(() => undefined),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      log: jest.spyOn(console, 'log').mockImplementation(() => undefined),
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('error は console.error だけに出す', () => {
    const consoleSpies = spyOnConsole();

    logger.error('店舗の取得に失敗した');

    expect(consoleSpies.error).toHaveBeenCalledWith('店舗の取得に失敗した');
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.log).not.toHaveBeenCalled();
  });

  it('warn は console.warn だけに出す', () => {
    const consoleSpies = spyOnConsole();

    logger.warn('位置情報の精度が低い');

    expect(consoleSpies.warn).toHaveBeenCalledWith('位置情報の精度が低い');
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.log).not.toHaveBeenCalled();
  });

  it('debug と info は console.log に出す', () => {
    // logger は __DEV__ で作られる。テスト環境が開発扱いでないと debug / info は sink に届かない
    expect(__DEV__).toBe(true);
    const consoleSpies = spyOnConsole();

    logger.info('地図を初期化した');
    logger.debug('地図を再検索する');

    expect(consoleSpies.log.mock.calls).toEqual([['地図を初期化した'], ['地図を再検索する']]);
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
  });

  it('context を渡すと message の後ろに並べて出す', () => {
    const consoleSpies = spyOnConsole();

    logger.error('店舗の取得に失敗した', { shopId: 'shp_1' });

    expect(consoleSpies.error.mock.calls).toEqual([['店舗の取得に失敗した', { shopId: 'shp_1' }]]);
  });

  it('context を渡さないと message だけを出す', () => {
    const consoleSpies = spyOnConsole();

    logger.warn('位置情報の精度が低い');

    // 第 2 引数に undefined を渡すと console に余計な undefined が並ぶため、引数列ごと検証する
    expect(consoleSpies.warn.mock.calls).toEqual([['位置情報の精度が低い']]);
  });
});
