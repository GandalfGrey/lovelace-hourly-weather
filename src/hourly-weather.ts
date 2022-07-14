/* eslint-disable @typescript-eslint/no-explicit-any */
import { LitElement, html, TemplateResult, css, PropertyValues, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  HomeAssistant,
  hasConfigOrEntityChanged,
  hasAction,
  ActionHandlerEvent,
  handleAction,
  LovelaceCardEditor,
  getLovelace,
  formatNumber,
  formatTime,
  FrontendLocaleData,
} from 'custom-card-helpers'; // This is a community maintained npm module with common helper functions/types. https://github.com/custom-cards/custom-card-helpers
import { isValidColorName, isValidHSL, isValidRGB } from 'is-valid-css-color';

import type { ColorConfig, ColorMap, ColorSettings, ConditionSpan, ForecastSegment, HourlyWeatherCardConfig, HourTemperature } from './types';
import { actionHandler } from './action-handler-directive';
import { version } from '../package.json';
import { localize } from './localize/localize';
import { WeatherBar } from './weather-bar';
import { ICONS } from './conditions';
customElements.define('weather-bar', WeatherBar);

/* eslint no-console: 0 */
console.info(
  `%c  HOURLY-WEATHER-CARD \n%c  ${localize('common.version')} ${version}    `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

// This puts your card into the UI card picker dialog
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'hourly-weather',
  name: localize('common.title_card'),
  description: localize('common.description'),
});

@customElement('hourly-weather')
export class HourlyWeatherCard extends LitElement {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import('./editor');
    return document.createElement('hourly-weather-editor');
  }

  public static getStubConfig(): Record<string, unknown> {
    return {};
  }

  // TODO Add any properities that should cause your element to re-render here
  // https://lit.dev/docs/components/properties/
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private config!: HourlyWeatherCardConfig;

  // https://lit.dev/docs/components/properties/#accessors-custom
  public setConfig(config: HourlyWeatherCardConfig): void {
    if (!config) {
      throw new Error(localize('common.invalid_configuration'));
    }

    if (!config.entity) {
      throw new Error(localize('errors.missing_entity'));
    }

    if (config.test_gui) {
      getLovelace().setEditMode(true);
    }

    this.config = {
      name: localize('common.title'),
      ...config,
    };
  }

  // https://lit.dev/docs/components/lifecycle/#reactive-update-cycle-performing
  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this.config) {
      return false;
    }

    return hasConfigOrEntityChanged(this, changedProps, false);
  }

  // https://lit.dev/docs/components/rendering/
  protected render(): TemplateResult | void {
    const entityId: string = this.config.entity;
    const state = this.hass.states[entityId];
    const { forecast } = state.attributes as { forecast: ForecastSegment[] };
    const numHours = parseInt(this.config.num_hours ?? '12', 10);
    const offset = parseInt(this.config.offset ?? '0', 10);

    const hoursPerSegment = this.determineHoursPerSegment(forecast);

    if (numHours > (forecast.length - offset) * hoursPerSegment) {
      return this._showError(localize('errors.too_many_hours_requested'));
    }

    const isForecastDaily = this.isForecastDaily(forecast);
    const conditionList = this.getConditionListFromForecast(forecast, numHours, hoursPerSegment, offset);
    const temperatures = this.getTemperatures(forecast, numHours, hoursPerSegment, offset);
    const numHoursNotMultiple = numHours % hoursPerSegment !== 0;

    const colorSettings = this.getColorSettings(this.config.colors);

    return html`
      <ha-card
        .header=${this.config.name}
        @action=${this._handleAction}
        .actionHandler=${actionHandler({
      hasHold: hasAction(this.config.hold_action),
      hasDoubleClick: hasAction(this.config.double_tap_action),
    })}
        tabindex="0"
        .label=${`Hourly Weather: ${this.config.entity || 'No Entity Defined'}`}
      >
        <div class="card-content">
          ${isForecastDaily ?
        this._showWarning(localize('errors.daily_forecasts')) : ''}
          ${numHoursNotMultiple ?
        this._showWarning(localize('errors.num_hours_not_multiple')
          .replace(/\{hoursPerSegment\}/g, formatNumber(hoursPerSegment, this.hass.locale))) : ''}
          ${colorSettings.warnings.length ?
        this._showWarning(localize('errors.invalid_colors') + colorSettings.warnings.join(', ')) : ''}
          <weather-bar
            .conditions=${conditionList}
            .temperatures=${temperatures}
            .icons=${!!this.config.icons}
            .colors=${colorSettings.validColors}
            .hide_hours=${!!this.config.hide_hours}
            .hide_temperatures=${!!this.config.hide_temperatures}></weather-bar>
        </div>
      </ha-card>
    `;
  }

  private determineHoursPerSegment(forecast: ForecastSegment[]): number {
    if (forecast.length < 2) return 1;
    const [fs1, fs2] = forecast;
    const delta = new Date(fs2.datetime).getTime() - new Date(fs1.datetime).getTime();
    return Math.round(delta / 1000 / 3600);
  }

  private getConditionListFromForecast(forecast: ForecastSegment[], numHours: number, hoursPerSegment: number, offset: number): ConditionSpan[] {
    let lastCond: string = forecast[offset].condition;
    let j = 0;
    const res: ConditionSpan[] = [[lastCond, 1]];
    for (let i = offset + 1; i * hoursPerSegment < numHours + offset * hoursPerSegment; i++) {
      const cond: string = forecast[i].condition;
      if (cond === lastCond) {
        res[j][1]++;
      } else {
        res.push([cond, 1]);
        j++;
        lastCond = cond;
      }
    }
    return res;
  }

  private getTemperatures(forecast: ForecastSegment[], numHours: number, hoursPerSegment: number, offset: number): HourTemperature[] {
    const temperatures: HourTemperature[] = [];
    for (let i = offset; i < Math.floor(numHours / hoursPerSegment) + offset; i++) {
      const fs = forecast[i];
      temperatures.push({
        hour: this.formatHour(new Date(fs.datetime), this.hass.locale),
        temperature: formatNumber(fs.temperature, this.hass.locale)
      })
    }
    return temperatures;
  }

  private isForecastDaily(forecast: ForecastSegment[]): boolean {
    const dates = forecast.map(f => new Date(f.datetime).getDate());
    const uniqueDates = new Set(dates);
    return uniqueDates.size >= forecast.length - 1;
  }

  private formatHour(time: Date, locale: FrontendLocaleData): string {
    const formatted = formatTime(time, locale);
    if (formatted.includes('AM') || formatted.includes('PM')) {
      // Drop ':00' in 12 hour time
      return formatted.replace(':00', '');
    }
    return formatted;
  }

  private getColorSettings(colorConfig?: ColorConfig): ColorSettings {
    if (!colorConfig) return {
      validColors: void 0,
      warnings: []
    };

    const validColors: ColorMap = new Map();
    const warnings: string[] = [];
    Object.entries(colorConfig).forEach(([k, v]) => {
      if (this.isValidColor(k, v))
        validColors.set(k as keyof ColorConfig, v);
      else
        warnings.push(`${k}: ${v}`);
    });
    return {
      validColors,
      warnings
    };
  }

  private isValidColor(key: string, color: string): boolean {
    if (!(key in ICONS)) {
      return false;
    }
    if (!(isValidRGB(color) ||
      isValidColorName(color) ||
      isValidHSL(color))) {
      return false;
    }

    return true;
  }

  private _handleAction(ev: ActionHandlerEvent): void {
    if (this.hass && this.config && ev.detail.action) {
      handleAction(this, this.hass, this.config, ev.detail.action);
    }
  }

  private _showWarning(warning: string): TemplateResult {
    return html` <hui-warning>${warning}</hui-warning> `;
  }

  private _showError(error: string): TemplateResult {
    const errorCard = document.createElement('hui-error-card');
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this.config,
    });

    return html` ${errorCard} `;
  }

  // https://lit.dev/docs/components/styles/
  static get styles(): CSSResultGroup {
    return css``;
  }
}
