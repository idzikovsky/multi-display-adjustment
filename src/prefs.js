// SPDX-FileCopyrightText: 2026 Samuel Cecilio
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw'
import Gio from 'gi://Gio'
import Gtk from 'gi://Gtk'

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'


// In the order of the choices in the enums of the slider-placement and inline-position keys
const PLACEMENTS = ['tile', 'inline']
const POSITIONS = ['below', 'above']

/**
 * Ties the switch `row` to the boolean setting `key`, except that a switch that
 * is greyed out shows as off, as an "on" would claim something that is not
 * there. The setting is left alone, so the switch is back as it was when it can
 * be used again. Returns a function to call after changing `row.sensitive`.
 */
function bindSwitch(window, settings, key, row) {
    const sync = () => {
        row.active = row.sensitive && settings.get_boolean(key)
    }

    row.connect('notify::active', () => {
        if (row.sensitive) {
            settings.set_boolean(key, row.active)
        }
    })

    const changedId = settings.connect(`changed::${key}`, sync)
    window.connect('close-request', () => settings.disconnect(changedId))

    sync()

    return sync
}

export default class MultiDisplayAdjustmentPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings()

        const group = new Adw.PreferencesGroup({ title: _('Sliders') })

        const groupDisplays = new Adw.SwitchRow({
            title: _('Adjust all external displays together')
        })
        const syncGroup = bindSwitch(window, settings, 'group-displays', groupDisplays)

        // Grouping joins external displays, so it takes two of them. The extension tells how many there are.
        const syncGroupAvailable = () => {
            const available = settings.get_int('external-display-count') >= 2

            groupDisplays.sensitive = available
            groupDisplays.subtitle = available
                ? _('One slider block controls all external displays')
                : _('Not available with fewer than two external displays')
            syncGroup()
        }

        const countChangedId = settings.connect('changed::external-display-count', syncGroupAvailable)
        window.connect('close-request', () => settings.disconnect(countChangedId))

        syncGroupAvailable()

        const showContrast = new Adw.SwitchRow({
            title: _('Show contrast sliders')
        })

        const syncContrast = bindSwitch(window, settings, 'show-contrast', showContrast)

        const placement = new Adw.ComboRow({
            title: _('Placement'),
            subtitle: _('Inline means among other Quick Settings sliders'),
            model: Gtk.StringList.new([_('Tile'), _('Inline')])
        })

        const positionSubtitle = _('Relative to GNOME\'s laptop display slider. No effect on PC.')

        const position = new Adw.ComboRow({
            title: _('Position'),
            subtitle: positionSubtitle,
            model: Gtk.StringList.new([_('Below'), _('Above')])
        })

        const syncPlacement = () => {
            const current = settings.get_string('slider-placement')

            placement.selected = PLACEMENTS.indexOf(current)
            position.selected = POSITIONS.indexOf(settings.get_string('inline-position'))
            position.sensitive = current === 'inline'
            position.subtitle = current === 'inline' ? positionSubtitle : _('Not available with tile placement')
            showContrast.sensitive = current === 'tile'
            syncContrast()

            // A greyed out switch alone is easy to miss, so say why it is
            showContrast.subtitle = current === 'tile' ? '' : _('Not available with inline placement')
        }

        syncPlacement()

        placement.connect('notify::selected', () => settings.set_string('slider-placement', PLACEMENTS[placement.selected]))
        position.connect('notify::selected', () => settings.set_string('inline-position', POSITIONS[position.selected]))

        const changedIds = ['slider-placement', 'inline-position']
            .map(key => settings.connect(`changed::${key}`, syncPlacement))
        window.connect('close-request', () => changedIds.forEach(id => settings.disconnect(id)))

        group.add(placement)
        group.add(position)

        const limitMinimum = new Adw.SwitchRow({
            title: _('Minimum brightness of 1%'),
            subtitle: _('Some displays turn the backlight off at 0, leaving no way to see the slider')
        })
        settings.bind('limit-minimum-brightness', limitMinimum, 'active', Gio.SettingsBindFlags.DEFAULT)

        group.add(limitMinimum)
        group.add(showContrast)
        group.add(groupDisplays)

        // The displays are only known to the shell, so auto-rotate is turned on
        // for each of them in its Displays menu
        const rotationGroup = new Adw.PreferencesGroup({
            title: _('Rotation'),
            description: _('Displays with an orientation sensor, such as some portable monitors, get an Auto Rotate switch in the Displays menu. Only with tile placement.')
        })

        const enableAutoRotate = new Adw.SwitchRow({
            title: _('Auto rotate'),
            subtitle: _('When off, no Auto Rotate switches are shown and displays are not polled')
        })
        settings.bind('enable-auto-rotate', enableAutoRotate, 'active', Gio.SettingsBindFlags.DEFAULT)

        const interval = new Adw.SpinRow({
            title: _('Polling interval'),
            subtitle: _('Seconds between orientation reads'),
            digits: 1,
            adjustment: new Gtk.Adjustment({
                lower: 0.5,
                upper: 60,
                step_increment: 0.5,
                page_increment: 5
            })
        })
        settings.bind('auto-rotate-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT)
        settings.bind('enable-auto-rotate', interval, 'sensitive', Gio.SettingsBindFlags.GET)

        rotationGroup.add(enableAutoRotate)
        rotationGroup.add(interval)

        const page = new Adw.PreferencesPage()
        page.add(group)
        page.add(rotationGroup)
        window.add(page)
    }
}
