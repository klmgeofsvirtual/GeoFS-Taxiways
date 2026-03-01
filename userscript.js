// ==UserScript==
// @name         GeoFS Ultimate Taxiway & Lights Pro
// @version      2.0
// @description  The Final Boss: Dynamic day/night asphalt, physical blue edges, and green/yellow centerlines!
// @author       You & Gemini
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geo-fs.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    window.twLights = [];
    window.twSurfaces = []; 
    window.errs = 0;

    if (!window.gmenu || !window.GMenu) {
        console.log("Taxiway Lights getting GMenu");
        fetch('https://raw.githubusercontent.com/tylerbmusic/GeoFS-Addon-Menu/refs/heads/main/addonMenu.js')
            .then(response => response.text())
            .then(script => {eval(script);})
            .then(() => {setTimeout(afterGMenu, 100);});
    }

    function afterGMenu() {
        const twLM = new window.GMenu("Taxiway Lights Pro", "twL");
        twLM.addItem("Render distance (degrees): ", "RenderDist", "number", 0, '0.05');
        twLM.addItem("Update Interval (seconds): ", "UpdateInterval", "number", 0, '5');
        twLM.addItem("Green/Yellow Light Size: ", "GSize", "number", 0, "0.05");
        twLM.addItem("Blue Light Size: ", "BSize", "number", 0, "0.07");
        if (localStorage.getItem("twLEnabled") == null) localStorage.setItem("twLEnabled", 'true');
        
        setTimeout(() => {window.updateLights();}, 100*Number(localStorage.getItem("twLUpdateInterval")));
    }
})();

window.updateLights = async function() {
    if (window.geofs.cautiousWithTerrain == false && (localStorage.getItem("twLEnabled") == 'true')) {
        var renderDistance = Number(localStorage.getItem("twLRenderDist")); 
        var l0 = Math.floor(window.geofs.aircraft.instance.llaLocation[0]/renderDistance)*renderDistance;
        var l1 = Math.floor(window.geofs.aircraft.instance.llaLocation[1]/renderDistance)*renderDistance;
        var bounds = (l0) + ", " + (l1) + ", " + (l0+renderDistance) + ", " + (l1+renderDistance);
        
        if (!window.lastBounds || (window.lastBounds != bounds)) {
            window.twLights.forEach(l => window.geofs.api.viewer.entities.remove(l));
            window.twSurfaces.forEach(s => window.geofs.api.viewer.entities.remove(s));
            window.twLights = [];
            window.twSurfaces = [];
            
            console.log("Fetching Taxiway Data for Area...");
            
            window.drawTaxiwaySurfaces(bounds);
            window.getTwD(bounds); 
            window.getTwDE(bounds); 
        }
        window.lastBounds = bounds;
    } else if ((localStorage.getItem("twLEnabled") != 'true')) {
        window.lastBounds = "";
        window.twLights.forEach(l => window.geofs.api.viewer.entities.remove(l));
        window.twSurfaces.forEach(s => window.geofs.api.viewer.entities.remove(s));
        window.twLights = [];
        window.twSurfaces = [];
    }
    setTimeout(() => {window.updateLights();}, 1000*Number(localStorage.getItem("twLUpdateInterval")));
}

// ---- HELPER FUNCTIONS ----
function calculateBearing(lon1, lat1, lon2, lat2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360; 
}

function calculateOffsetPoint(lon, lat, bearing, offsetDistance) {
    const R = 6378137; 
    const bearingRad = (bearing + 90) * Math.PI / 180; 
    const dLat = offsetDistance * Math.cos(bearingRad) / R;
    const dLon = offsetDistance * Math.sin(bearingRad) / (R * Math.cos(Math.PI * lat / 180));
    return {
        lonPlus: lon + dLon * 180 / Math.PI, latPlus: lat + dLat * 180 / Math.PI,
        lonMinus: lon - dLon * 180 / Math.PI, latMinus: lat - dLat * 180 / Math.PI
    };
}

function interpolatePoints(start, end, interval) {
    const [lon1, lat1] = start; const [lon2, lat2] = end;
    const distance = Math.sqrt(Math.pow(lon2 - lon1, 2) + Math.pow(lat2 - lat1, 2));
    const numPoints = Math.max(Math.floor(distance / interval), 1);
    const interpolated = [];
    for (let i = 0; i <= numPoints; i++) {
        const ratio = i / numPoints;
        interpolated.push([lon1 + (lon2 - lon1) * ratio, lat1 + (lat2 - lat1) * ratio, 0]);
    }
    return interpolated;
}

function checkProximityToRunway(pos) {
    try {
        if (!window.runwayThresholds) {
            window.runwayThresholds = [];
            for (var i in window.geofs.runways.nearRunways) {
                const nearestRunway = window.geofs.runways.nearRunways[i];
                if (nearestRunway && nearestRunway.threshold1 && nearestRunway.threshold2) {
                    window.runwayThresholds.push(interpolatePoints(
                        [nearestRunway.threshold1[1], nearestRunway.threshold1[0]], 
                        [nearestRunway.threshold2[1], nearestRunway.threshold2[0]], 5 / 111000
                    ));
                }
            }
        }
        const distSquared = (40 / 111000) ** 2; // Distance threshold for turning lights yellow
        const posLon = pos[0]; const posLat = pos[1];
        for (var v in window.runwayThresholds) {
            if (window.runwayThresholds[v].some(([lon, lat]) => (lon - posLon)**2 + (lat - posLat)**2 < distSquared)) {
                return true;
            }
        }
    } catch (e) {
        return false;
    }
    return false;
}

// ---- DATA FETCHING ----
async function fetchOverpass(bounds) {
    const query = `[out:json];(way["aeroway"="taxiway"](${bounds}););out body;>;out skel qt;`;
    const response = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
    return await response.json();
}

// ---- DRAW PHYSICAL TAXIWAYS & LINES ----
window.drawTaxiwaySurfaces = async function(bounds) {
    const data = await fetchOverpass(bounds);
    const nodes = {};
    data.elements.forEach(el => { if (el.type === 'node') nodes[el.id] = el; });

    data.elements.forEach(element => {
        if (element.type === 'way') {
            const wayCoords = [];
            element.nodes.forEach(nodeId => {
                if (nodes[nodeId]) wayCoords.push(nodes[nodeId].lon, nodes[nodeId].lat);
            });

            if (wayCoords.length >= 4) { 
                // Dark Asphalt Tint (Looks like grey asphalt by day, completely black/invisible by night)
                window.twSurfaces.push(window.geofs.api.viewer.entities.add({
                    corridor: {
                        positions: window.Cesium.Cartesian3.fromDegreesArray(wayCoords),
                        width: 18.0, 
                        material: window.Cesium.Color.fromCssColorString('#111111').withAlpha(0.65), 
                        clampToGround: true,
                        classificationType: window.Cesium.ClassificationType.TERRAIN,
                        zIndex: 1
                    }
                }));

                // Faded Yellow Paint 
                window.twSurfaces.push(window.geofs.api.viewer.entities.add({
                    corridor: {
                        positions: window.Cesium.Cartesian3.fromDegreesArray(wayCoords),
                        width: 0.4, 
                        material: window.Cesium.Color.fromCssColorString('#d4b200').withAlpha(0.35), 
                        clampToGround: true,
                        classificationType: window.Cesium.ClassificationType.TERRAIN,
                        zIndex: 2
                    }
                }));
            }
        }
    });
};

// ---- BLUE EDGE LIGHTS ----
window.getTwD = async function(bounds) {
    const data = await fetchOverpass(bounds);
    const nodes = {};
    data.elements.forEach(el => { if (el.type === 'node') nodes[el.id] = el; });

    data.elements.forEach(element => {
        if (element.type === 'way') {
            const wayNodes = element.nodes.map(nodeId => nodes[nodeId] ? [nodes[nodeId].lon, nodes[nodeId].lat, 0] : null).filter(Boolean);
            if (wayNodes.length > 1) {
                const interval = 0.0002;
                for (let i = 0; i < wayNodes.length - 1; i++) {
                    const segmentPoints = interpolatePoints(wayNodes[i], wayNodes[i + 1], interval);
                    const bearing = calculateBearing(wayNodes[i][0], wayNodes[i][1], wayNodes[i + 1][0], wayNodes[i + 1][1]);
                    
                    segmentPoints.forEach(([lon, lat, alt]) => {
                        const offsetPoints = calculateOffsetPoint(lon, lat, bearing, 9); 
                        [[offsetPoints.lonPlus, offsetPoints.latPlus], [offsetPoints.lonMinus, offsetPoints.latMinus]].forEach(epos => {
                            
                            // Sets height to EXACTLY 0.2m above terrain dynamically
                            const pos = window.Cesium.Cartesian3.fromDegrees(epos[0], epos[1], 0.2);
                            
                            window.twLights.push(window.geofs.api.viewer.entities.add({
                                position: pos,
                                billboard: {
                                    image: "https://tylerbmusic.github.io/GPWS-files_geofs/bluelight.png",
                                    scale: (Number(localStorage.getItem("twLBSize")) || 0.07) * (1 / window.geofs.api.renderingSettings.resolutionScale),
                                    scaleByDistance: new window.Cesium.NearFarScalar(1, 0.5, 2000, 0.05),
                                    translucencyByDistance: new window.Cesium.NearFarScalar(500, 1.0, 3500, 0.0), 
                                    distanceDisplayCondition: new window.Cesium.DistanceDisplayCondition(0, 4000), 
                                    verticalOrigin: window.Cesium.VerticalOrigin.BOTTOM,
                                    heightReference: window.Cesium.HeightReference.RELATIVE_TO_GROUND
                                }
                            }));
                        });
                    });
                }
            }
        }
    });
};

// ---- CENTER GREEN & YELLOW LIGHTS ----
window.getTwDE = async function(bounds) {
    const data = await fetchOverpass(bounds);
    const nodes = {};
    data.elements.forEach(el => { if (el.type === 'node') nodes[el.id] = el; });

    data.elements.forEach(element => {
        if (element.type === 'way') {
            const wayNodes = element.nodes.map(nodeId => nodes[nodeId] ? [nodes[nodeId].lon, nodes[nodeId].lat, 0] : null).filter(Boolean);
            if (wayNodes.length > 1) {
                const interval = 0.00007; 
                for (let i = 0; i < wayNodes.length - 1; i++) {
                    const segmentPoints = interpolatePoints(wayNodes[i], wayNodes[i + 1], interval);
                    
                    segmentPoints.forEach(epos => {
                        const isNearRunway = checkProximityToRunway(epos);
                        
                        // Sets height to EXACTLY 0.15m above terrain (Pops up above the asphalt layer!)
                        const pos = window.Cesium.Cartesian3.fromDegrees(epos[0], epos[1], 0.15);
                        
                        const lightImage = isNearRunway ? 
                            "https://tylerbmusic.github.io/GPWS-files_geofs/yellowlight.png" : 
                            "https://tylerbmusic.github.io/GPWS-files_geofs/greenlight.png";
                        
                        window.twLights.push(window.geofs.api.viewer.entities.add({
                            position: pos,
                            billboard: {
                                image: lightImage,
                                scale: (Number(localStorage.getItem("twLGSize")) || 0.05) * (1 / window.geofs.api.renderingSettings.resolutionScale),
                                scaleByDistance: new window.Cesium.NearFarScalar(1, 1, 2000, 0.05),
                                translucencyByDistance: new window.Cesium.NearFarScalar(500, 1.0, 3500, 0.0),
                                distanceDisplayCondition: new window.Cesium.DistanceDisplayCondition(0, 4000),
                                verticalOrigin: window.Cesium.VerticalOrigin.BOTTOM,
                                heightReference: window.Cesium.HeightReference.RELATIVE_TO_GROUND
                            }
                        }));
                    });
                }
            }
        }
    });
};
