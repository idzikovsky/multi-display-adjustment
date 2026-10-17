// SPDX-FileCopyrightText: 2026 Samuel Cecilio
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import St from 'gi://St'

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js'

import { devLog } from './code-convenience.js'


// Screen Orientation in MCCS, reported by displays with an orientation sensor
const ORIENTATION_VCP_CODE = 0xAA

// The `key` (model and serial) of every display auto-rotate is on for
const ENABLED_DISPLAYS_KEY = 'auto-rotate-displays'

// The same reading this many times in a row before rotating, so that a display
// being turned does not rotate back and forth on the way
const STABLE_READS = 2

/**
 * VCP 0xAA values to Mutter transforms: 0x01 is 0°, 0x02 90°, 0x03 180° and
 * 0x04 270°. 0xFF means the display cannot tell.
 */
const VCP_TO_TRANSFORM = new Map([
    [0x01, 0],
    [0x02, 1],
    [0x03, 2],
    [0x04, 3]
])

/**
 * Polls the orientation of the displays that report one and have auto-rotate
 * turned on, and rotates them in Mutter when it changes.
 *
 * Only a change of orientation rotates a display, so a rotation picked by hand
 * in Settings stays until the display is turned. Turning auto-rotate on for a
 * display rotates it to its current orientation.
 */
class AutoRotator {
    constructor(ddcutilService, displayConfigService, settings, onDisplaysChanged) {
        this._ddcutilService = ddcutilService
        this._displayConfigService = displayConfigService
        this._settings = settings
        this._onDisplaysChanged = onDisplaysChanged

        // Every display given to setDisplays(), to look at again when the
        // feature is turned back on
        this._allDisplays = []

        // The ones among them that report an orientation
        this._displays = []
        this._readings = new Map()
        this._cancellable = new Gio.Cancellable()
        this._timeoutId = 0

        // Bumped whenever polling restarts, so that a poll in flight does not
        // schedule another one next to the new one
        this._generation = 0

        this._settings.connectObject(
            `changed::${ENABLED_DISPLAYS_KEY}`, () => this._restartPolling(),
            'changed::auto-rotate-interval', () => this._restartPolling(),
            'changed::enable-auto-rotate', () => {
                this.setDisplays(this._allDisplays)
                    .catch(error => logError(error, '[multi-display-adjustment] Could not read display orientations'))
            },
            this)
    }

    _enabledDisplays() {
        const enabledKeys = this._settings.get_strv(ENABLED_DISPLAYS_KEY)

        return this._displays.filter(display => enabledKeys.includes(display.key))
    }

    /**
     * Finds which of `displays` report an orientation and polls those.
     */
    async setDisplays(displays) {
        this._cancellable.cancel()
        this._cancellable = new Gio.Cancellable()
        const cancellable = this._cancellable

        this._allDisplays = displays
        this._displays = []
        this._readings.clear()
        this._restartPolling()

        // Turned off, nothing is read from the displays and no switch shows
        if (!this._settings.get_boolean('enable-auto-rotate')) {
            this._onDisplaysChanged([])

            return
        }

        const rotatable = []

        try {
            for (const display of displays) {
                const reading = await this._ddcutilService.getVcp(display.displayId, ORIENTATION_VCP_CODE, cancellable)

                if (reading !== null && VCP_TO_TRANSFORM.has(reading.current)) {
                    rotatable.push(display)
                }
            }
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                return
            }

            throw error
        }

        devLog('[multi-display-adjustment] Displays with an orientation sensor', rotatable)

        this._displays = rotatable
        this._onDisplaysChanged(rotatable)
        this._restartPolling()
    }

    _restartPolling() {
        this._generation++

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId)
            this._timeoutId = 0
        }

        const enabled = this._enabledDisplays()

        // A display turned off and on again starts over, and so rotates to
        // its current orientation. The others keep their readings, so turning
        // one display on does not undo a rotation picked by hand on another.
        for (const connector of this._readings.keys()) {
            if (!enabled.some(display => display.connector === connector)) {
                this._readings.delete(connector)
            }
        }

        if (enabled.length > 0) {
            this._schedule(this._generation)
        }
    }

    _schedule(generation) {
        const interval = Math.round(this._settings.get_double('auto-rotate-interval') * 1000)

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._timeoutId = 0
            this._poll(generation).catch(error => logError(error, '[multi-display-adjustment] Could not poll orientation'))

            return GLib.SOURCE_REMOVE
        })
    }

    /**
     * Reads every display once, then schedules the next poll. The next poll
     * waits for this one, since a slow display would otherwise pile them up.
     */
    async _poll(generation) {
        const cancellable = this._cancellable

        try {
            for (const display of this._enabledDisplays()) {
                const reading = await this._ddcutilService.getVcp(display.displayId, ORIENTATION_VCP_CODE, cancellable)

                if (generation !== this._generation) {
                    return
                }

                if (reading !== null) {
                    await this._handleReading(display, reading.current)
                }
            }
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                return
            }

            throw error
        }

        if (generation === this._generation) {
            this._schedule(generation)
        }
    }

    async _handleReading(display, value) {
        const previous = this._readings.get(display.connector)
        const streak = previous?.value === value ? previous.streak + 1 : 1

        this._readings.set(display.connector, { value, streak })

        // Exactly at the threshold, so a steady orientation rotates only once
        if (streak !== STABLE_READS || !VCP_TO_TRANSFORM.has(value)) {
            return
        }

        const transform = VCP_TO_TRANSFORM.get(value)

        try {
            if (await this._displayConfigService.rotate(display.connector, transform)) {
                devLog('[multi-display-adjustment] Rotated', display.connector, 'to transform', transform)
            }
        } catch (error) {
            logError(error, `[multi-display-adjustment] Could not rotate ${display.connector}`)

            // Starts the count over, so the next stable reading tries again
            // instead of waiting for the display to be turned
            this._readings.delete(display.connector)
        }
    }

    destroy() {
        this._settings.disconnectObject(this)
        this._cancellable.cancel()

        this._displays = []
        this._readings.clear()
        this._restartPolling()
    }
}

/**
 * A switch in the Displays menu that turns auto-rotate on or off for one
 * display.
 */
const AutoRotateSwitchItem = GObject.registerClass(
class AutoRotateSwitchItem extends PopupMenu.PopupSwitchMenuItem {
    _init(settings, display, label = _('Auto Rotate')) {
        super._init(label, false)

        this._settings = settings
        this._key = display.key

        // The switch has a drag gesture that also takes a plain click, and
        // activate() toggles as well, so a click on the switch toggled twice
        // and changed nothing. The item alone takes the clicks now. The item
        // passes its own reactive on to the switch whenever its sensitivity
        // syncs, so the switch is made unreactive again each time.
        this._switch.reactive = false
        this._switch.connect('notify::reactive', () => {
            if (this._switch.reactive) {
                this._switch.reactive = false
            }
        })

        // After the ornament, so that it lines up with the icons of the sliders
        this.insert_child_at_index(new St.Icon({
            icon_name: 'rotation-allowed-symbolic',
            style_class: 'popup-menu-icon'
        }), 1)

        this._settings.connectObject(`changed::${ENABLED_DISPLAYS_KEY}`, () => this._sync(), this)
        this.connect('toggled', (_item, state) => this._saveState(state))
        this.connect('destroy', () => this._settings.disconnectObject(this))

        this._sync()
    }

    // Toggles without emitting 'activate', which would close Quick Settings,
    // so that the switch can be seen to change and the sliders stay in reach
    activate(_event) {
        this.toggle()
    }

    // setToggleState() emits 'toggled' too, which only needs saving on a click
    _sync() {
        this._syncing = true
        this.setToggleState(this._settings.get_strv(ENABLED_DISPLAYS_KEY).includes(this._key))
        this._syncing = false
    }

    // Not called _onToggled(), which would replace the method of
    // PopupSwitchMenuItem that emits 'toggled'
    _saveState(state) {
        if (this._syncing) {
            return
        }

        // A set, so that a key listed twice by an older version goes in one click
        const enabledKeys = new Set(this._settings.get_strv(ENABLED_DISPLAYS_KEY))

        if (state) {
            enabledKeys.add(this._key)
        } else {
            enabledKeys.delete(this._key)
        }

        this._settings.set_strv(ENABLED_DISPLAYS_KEY, [...enabledKeys])
    }
})

export { AutoRotateSwitchItem, AutoRotator }
