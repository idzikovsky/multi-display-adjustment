// SPDX-FileCopyrightText: Maciej Wójcik and the display-adjustment contributors
// SPDX-FileCopyrightText: 2026 Samuel Cecilio
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio'

import { devLog, getPossibleBoolean, getPossibleString } from './code-convenience.js'


// ApplyMonitorsConfig methods: 1 applies until the next change, without the
// confirmation dialog or saving to monitors.xml
const APPLY_METHOD_TEMPORARY = 1

// The layout-mode property: 1 is logical (sizes divided by scale), 2 physical
const LAYOUT_MODE_PHYSICAL = 2

/**
 * The logical monitors of a GetCurrentState reply, packed for
 * ApplyMonitorsConfig, with the one showing `connector` given `transform`.
 *
 * Rotating changes the size of that monitor, so the monitors to the right of
 * it and below it move by the difference, and the layout is moved back to
 * start at (0, 0). Returns null when the monitor already has `transform`.
 */
function rotatedLayout(monitors, logicalMonitors, properties, connector, transform) {
    const physical = properties['layout-mode']?.get_uint32() === LAYOUT_MODE_PHYSICAL

    const currentModes = new Map()

    for (const [[monitorConnector], modes] of monitors) {
        const mode = modes.find(candidate => getPossibleBoolean(candidate[6], 'is-current'))

        if (mode !== undefined) {
            currentModes.set(monitorConnector, mode)
        }
    }

    const target = logicalMonitors.find(logicalMonitor =>
        logicalMonitor[5].some(([monitorConnector]) => monitorConnector === connector))

    if (target === undefined || !currentModes.has(connector)) {
        throw new Error(`${connector} is not an active display`)
    }

    const [targetX, targetY, targetScale, targetTransform] = target

    if (targetTransform === transform) {
        return null
    }

    // Size in layout coordinates, with the sides swapped by 90° and 270°
    const sizeWith = someTransform => {
        const [, width, height] = currentModes.get(connector)
        const scale = physical ? 1 : targetScale
        const size = [Math.round(width / scale), Math.round(height / scale)]

        return someTransform % 2 === 1 ? size.reverse() : size
    }

    const [oldWidth, oldHeight] = sizeWith(targetTransform)
    const [newWidth, newHeight] = sizeWith(transform)

    const layout = logicalMonitors.map(logicalMonitor => {
        let [x, y, scale, logicalTransform, primary, monitorSpecs] = logicalMonitor

        if (logicalMonitor === target) {
            logicalTransform = transform
        } else {
            if (x >= targetX + oldWidth) {
                x += newWidth - oldWidth
            }

            if (y >= targetY + oldHeight) {
                y += newHeight - oldHeight
            }
        }

        const applyMonitors = monitorSpecs
            .filter(([monitorConnector]) => currentModes.has(monitorConnector))
            .map(([monitorConnector]) => [monitorConnector, currentModes.get(monitorConnector)[0], {}])

        return [x, y, scale, logicalTransform, primary, applyMonitors]
    })

    const minX = Math.min(...layout.map(([x]) => x))
    const minY = Math.min(...layout.map(([, y]) => y))

    return layout.map(([x, y, ...rest]) => [x - minX, y - minY, ...rest])
}

class DisplayConfigService {
    /**
     * A subset of org.gnome.Mutter.DisplayConfig.xml from Mutter 46.2. The
     * shell's loadInterfaceXML() cannot be used, because some distributions,
     * Ubuntu 24.04 among them, do not package that file.
     */
    _displayConfigInterface = `
        <!DOCTYPE node PUBLIC
        '-//freedesktop//DTD D-BUS Object Introspection 1.0//EN'
        'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd'>
        <node>
            <interface name="org.gnome.Mutter.DisplayConfig">

            <signal name="MonitorsChanged" />

            <method name="GetCurrentState">
                <arg name="serial" direction="out" type="u" />
                <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})" />
                <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})" />
                <arg name="properties" direction="out" type="a{sv}" />
            </method>

            <method name="ApplyMonitorsConfig">
                <arg name="serial" direction="in" type="u" />
                <arg name="method" direction="in" type="u" />
                <arg name="logical_monitors" direction="in" type="a(iiduba(ssa{sv}))" />
                <arg name="properties" direction="in" type="a{sv}" />
            </method>

            </interface>
        </node>`

    async init() {
        const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(this._displayConfigInterface)

        this._proxy = await new Promise((resolve, reject) => {
            DisplayConfigProxy(
                Gio.DBus.session, 'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                (proxy, error) => {
                    if (error === null) {
                        resolve(proxy)
                    } else {
                        reject(error)
                    }
                },
                null, Gio.DBusProxyFlags.NONE
            )
        })
    }

    connectMonitorsChanged(callback) {
        this._monitorsChangedId = this._proxy.connectSignal('MonitorsChanged', () => callback())
    }

    disconnectMonitorsChanged() {
        if (this._monitorsChangedId) {
            this._proxy.disconnectSignal(this._monitorsChangedId)
            this._monitorsChangedId = null
        }
    }

    /**
     * Displays sharing a column are ordered top to bottom.
     */
    _orderLeftToRight(displays) {
        return [...displays].sort((a, b) => a.x - b.x || a.y - b.y)
    }

    _findMode(modes, property) {
        return modes.find(mode => getPossibleBoolean(mode[6], property))
    }

    async _getLayoutFromMutter() {
        const currentState = await this._proxy.GetCurrentStateAsync()

        const layout = {}

        for (const [monitorSpec, modes, monitorProperties] of currentState[1]) {
            const [connector, vendor, model, serial] = monitorSpec

            if (connector.startsWith('None')) {
                continue
            }

            // The same localized name that Settings shows, e.g. `LG Electronics 27"`
            const name = getPossibleString(monitorProperties, 'display-name') || `${vendor} ${model}`.trim() || connector

            const currentMode = this._findMode(modes, 'is-current')
            const mode = currentMode ?? this._findMode(modes, 'is-preferred')

            if (mode === undefined) {
                continue
            }

            layout[connector] = {
                connector,
                vendor,
                model,
                serial,
                name,
                width: mode[1],
                height: mode[2],
                enabled: currentMode !== undefined
            }
        }

        for (const logicalMonitor of currentState[2]) {
            const [x, y] = logicalMonitor

            for (const [connector] of logicalMonitor[5]) {
                if (connector in layout) {
                    layout[connector].x = x
                    layout[connector].y = y
                }
            }
        }

        devLog('[multi-display-adjustment] Retrieved displays layout from Mutter', Object.values(layout))

        return Object.values(layout)
    }

    /**
     * Enabled displays, ordered by position. `key` is what ddcutil-service
     * displays are matched against, and two identical displays can share it.
     */
    async getDisplays() {
        const layout = await this._getLayoutFromMutter()

        const enabledDisplays = layout
            .filter(display => display.enabled)
            .map(display => ({ ...display, key: `${display.model}#${display.serial}` }))

        return this._orderLeftToRight(enabledDisplays)
    }

    /**
     * Gives the display on `connector` the Mutter `transform`, 0 to 3 for 0°,
     * 90°, 180° and 270°, until the next change of the layout. Returns false
     * when it already has it.
     */
    async rotate(connector, transform) {
        const [serial, monitors, logicalMonitors, properties] = await this._proxy.GetCurrentStateAsync()

        const layout = rotatedLayout(monitors, logicalMonitors, properties, connector, transform)

        if (layout === null) {
            return false
        }

        // The layout is in the coordinates of the current layout mode, while
        // Mutter applies it in its default mode unless told otherwise. It
        // refuses the property where the mode cannot be changed.
        const applyProperties = {}

        if (getPossibleBoolean(properties, 'supports-changing-layout-mode') && 'layout-mode' in properties) {
            applyProperties['layout-mode'] = properties['layout-mode']
        }

        devLog('[multi-display-adjustment] Applying rotated layout', layout, applyProperties)

        await this._proxy.ApplyMonitorsConfigAsync(serial, APPLY_METHOD_TEMPORARY, layout, applyProperties)

        return true
    }
}

export { DisplayConfigService }
