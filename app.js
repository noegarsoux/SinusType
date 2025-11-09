/* global GIF */

const GIF_WORKER_SOURCE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
let gifWorkerUrlPromise = null;

async function ensureGifWorkerUrl() {
    if (gifWorkerUrlPromise) {
        return gifWorkerUrlPromise;
    }

    gifWorkerUrlPromise = (async () => {
        try {
            const response = await fetch(GIF_WORKER_SOURCE_URL, { mode: 'cors' });
            if (!response.ok) {
                throw new Error(`Impossible de charger le worker GIF (statut ${response.status})`);
            }
            let scriptText = await response.text();
            scriptText = scriptText.replace(/\/\/[#@]\s*sourceMappingURL=.*$/m, '');
            const blob = new Blob([scriptText], { type: 'application/javascript' });
            return URL.createObjectURL(blob);
        } catch (error) {
            gifWorkerUrlPromise = null;
            throw error;
        }
    })();

    return gifWorkerUrlPromise;
}

// Attendre que le DOM soit chargé
window.addEventListener('DOMContentLoaded', function() {
    init();
});

function init() {
    // Initialisation WebGL
    const canvas = document.getElementById('glCanvas');
    if (!canvas) {
        console.error('Canvas introuvable!');
        return;
    }
    
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    
    if (!gl) {
        alert('WebGL n\'est pas supporté par votre navigateur');
        return;
    }
    
    // Créer le canvas 2D pour le texte (doit être créé avant resizeCanvas)
    const textCanvas = document.createElement('canvas');
    const textCtx = textCanvas.getContext('2d');
    textCanvas.style.position = 'absolute';
    textCanvas.style.top = '0';
    textCanvas.style.left = '0';
    textCanvas.style.pointerEvents = 'none';
    canvas.parentElement.appendChild(textCanvas);
    
    // Ajuster la taille du canvas
    function resizeCanvas() {
        const container = canvas.parentElement;
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
        if (gl) {
            gl.viewport(0, 0, canvas.width, canvas.height);
        }
        if (textCanvas) {
            textCanvas.width = canvas.width;
            textCanvas.height = canvas.height;
        }
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Variables globales
    let uniforms = {
        numCurves: 5,
        amplitude: 50,
        frequency: 2,
        speed: 2.0, // Vitesse augmentée par défaut
        spacing: 0.8,
        time: 0,
        backgroundColor: [0.0, 0.0, 0.0], // Noir par défaut
        resolution: [canvas.width, canvas.height],
        hue: 0.0, // Rotation de hue en degrés (0-360)
        motionBlur: 0.0, // Intensité du flou directionnel (0-50)
        phase: 0.0, // Phase de la sinusoïde en degrés (0-360)
        waveType: 0.0, // Type d'onde : 0=Sin, 1=Triangle, 2=Square, 3=Sawtooth, 4=Inverse Sawtooth
        rotation: 0.0, // Rotation des courbes en degrés (0-360)
        verticalOffset: 0.0, // Décalage vertical en pixels (-100 à 100)
        timeStagger: 0.0, // Décalage temporel entre les lignes (0-2)
        heatMapEnabled: 1.0, // Heat map activée par défaut (1.0 = on, 0.0 = off)
        grain: 0.0, // Intensité du grain/grunge (0-100)
        textColor: [1.0, 1.0, 1.0], // Couleur du texte (blanc par défaut)
        preserveImageColor: 0.0 // 1 = garder les couleurs de l'image quand imageMode
    };

    let textData = {
        entries: ['SINUS'],
        size: 96,
        fontFamily: 'Arial'
    };
    
    // Mode image: si une image est chargée, on remplace le rendu texte par l'image
    let imageMode = false;
    let loadedImage = null;
    const MAX_TEXT_VARIANTS = 10;
    
    // Mettre à jour la valeur par défaut dans l'HTML
    document.getElementById('textSize').value = 96;
    document.getElementById('textSizeValue').textContent = 96;

    // Shader vertex
    const vertexShaderSource = `
    attribute vec2 a_position;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

    // Shader fragment pour le post-processing avec déformation géométrique réelle et heat map
    const fragmentShaderSource = `
    precision mediump float;
    
    uniform sampler2D u_texture;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform float u_frequency;
    uniform float u_amplitude;
    uniform float u_numCurves;
    uniform float u_spacing;
    uniform float u_hue;
    uniform float u_motionBlur;
    uniform float u_phase;
    uniform float u_waveType;
    uniform float u_rotation;
    uniform float u_verticalOffset;
    uniform float u_timeStagger;
    uniform float u_heatMapEnabled;
    uniform float u_grain;
    uniform vec3 u_textColor;
    uniform vec3 u_backgroundColor;
    uniform float u_preserveImageColor;
    
    // Fonction de bruit simple pour le grain
    float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }
    
    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        
        vec2 u = f * f * (3.0 - 2.0 * f);
        
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    
    // Fonction pour générer différents types d'ondes
    float waveFunction(float t) {
        // Normaliser t dans la plage 0-2π pour un cycle complet, puis mapper à 0-1
        float normalizedT = mod(t, 2.0 * 3.14159) / (2.0 * 3.14159);
        float cycleT = normalizedT * 2.0 - 1.0; // -1 à 1
        
        
        if (u_waveType < 0.5) {
            // Type 0: Sinus (par défaut)
            return sin(t);
            
        } else if (u_waveType < 1.5) {
            // Type 1: Triangle
            float triangle;
            if (normalizedT < 0.5) {
                triangle = normalizedT * 4.0 - 1.0;
            } else {
                triangle = 3.0 - normalizedT * 4.0;
            }
            return triangle;
            
        } else if (u_waveType < 2.5) {
            // Type 2: Square (carré)
            return sin(t) >= 0.0 ? 1.0 : -1.0;
            
        } else if (u_waveType < 3.5) {
            // Type 3: Sawtooth (dent de scie montante)
            return normalizedT * 2.0 - 1.0;
            
        } else if (u_waveType < 4.5) {
            // Type 4: Inverse Sawtooth (dent de scie descendante)
            return 1.0 - normalizedT * 2.0;
            
        } else if (u_waveType < 5.5) {
            // Type 5: Smooth Step (transition douce S-curve)
            return smoothstep(0.0, 1.0, normalizedT) * 2.0 - 1.0;
            
        } else if (u_waveType < 6.5) {
            // Type 6: Pulse (impulsion centrée)
            float pulse = abs(cycleT);
            return exp(-pulse * 4.0) * 2.0 - 1.0;
            
        } else if (u_waveType < 7.5) {
            // Type 7: Bell (Gaussian - cloche)
            float bell = cycleT * 2.0;
            return exp(-bell * bell * 2.0) * 2.0 - 1.0;
            
        } else if (u_waveType < 8.5) {
            // Type 8: Bounce (rebond)
            float bounceT = normalizedT;
            float bounce;
            if (bounceT < 0.5) {
                // Montée avec rebond
                bounce = abs(sin(bounceT * 4.0 * 3.14159)) * 2.0 - 1.0;
            } else {
                // Descente avec rebond
                bounce = -abs(sin((bounceT - 0.5) * 4.0 * 3.14159)) * 2.0 + 1.0;
            }
            return bounce;
            
        } else if (u_waveType < 9.5) {
            // Type 9: Elastic (élastique - oscillation avec amortissement)
            float elasticT = normalizedT * 2.0 - 1.0;
            return sin(elasticT * 3.14159 * 3.0) * exp(-abs(elasticT) * 2.0);
            
        } else if (u_waveType < 10.5) {
            // Type 10: Ease In Out (accélération et décélération)
            float ease;
            if (normalizedT < 0.5) {
                ease = normalizedT * 2.0;
                ease = ease * ease;
            } else {
                ease = (1.0 - normalizedT) * 2.0;
                ease = 1.0 - ease * ease;
            }
            return ease * 2.0 - 1.0;
            
        } else if (u_waveType < 11.5) {
            // Type 11: Double Sin (double fréquence)
            return sin(t * 2.0) * 0.7 + sin(t) * 0.3;
            
        } else if (u_waveType < 12.5) {
            // Type 12: Stairs (escalier)
            float steps = 8.0;
            return floor(normalizedT * steps) / steps * 2.0 - 1.0;
            
        } else if (u_waveType < 13.5) {
            // Type 13: Spike (pics pointus répétés)
            float spikeT = mod(normalizedT * 4.0, 1.0);
            if (spikeT < 0.1) {
                return spikeT * 20.0 - 1.0; // Montée rapide
            } else {
                return 1.0 - (spikeT - 0.1) * 2.0; // Descente
            }
            
        } else if (u_waveType < 14.5) {
            // Type 14: Heartbeat (battement de cœur)
            float beat = mod(normalizedT * 2.0, 1.0);
            if (beat < 0.3) {
                return smoothstep(0.0, 0.3, beat) * 1.5 - 0.5; // Premier pic
            } else if (beat < 0.4) {
                return 1.0 - smoothstep(0.3, 0.4, beat) * 2.0; // Chute
            } else if (beat < 0.5) {
                return smoothstep(0.4, 0.5, beat) * 0.6 - 0.3; // Second pic plus petit
            } else {
                return -0.3 - smoothstep(0.5, 1.0, beat) * 0.7; // Retour à la base
            }
            
        } else if (u_waveType < 15.5) {
            // Type 15: Tent (forme de tente)
            if (normalizedT < 0.5) {
                return normalizedT * 4.0 - 1.0; // Montée linéaire
            } else {
                return 3.0 - normalizedT * 4.0; // Descente linéaire
            }
            
        } else if (u_waveType < 16.5) {
            // Type 16: Chaotic (mouvement chaotique)
            return sin(t * 2.3) * 0.5 + sin(t * 3.7) * 0.3 + sin(t * 5.1) * 0.2 + 
                   cos(t * 1.9) * 0.3 + cos(t * 4.3) * 0.2;
            
        } else if (u_waveType < 17.5) {
            // Type 17: Spiral Wave (onde en spirale)
            return sin(t * 2.0 + normalizedT * 3.14159 * 4.0) * 0.7 + 
                   cos(t * 1.5) * 0.3;
            
        } else if (u_waveType < 18.5) {
            // Type 18: Wave Packet (paquet d'onde avec enveloppe)
            float envelope = exp(-abs(normalizedT - 0.5) * 4.0);
            return sin(t * 8.0) * envelope * 2.0 - 1.0;
            
        } else if (u_waveType < 19.5) {
            // Type 19: Kink (point de rupture net)
            float kinkPos = 0.5;
            float distFromKink = abs(normalizedT - kinkPos);
            if (normalizedT < kinkPos) {
                return normalizedT * 4.0 - 1.0;
            } else {
                return 1.0 - (normalizedT - kinkPos) * 4.0;
            }
            
        } else if (u_waveType < 20.5) {
            // Type 20: Modulated (modulation complexe)
            float carrier = sin(t * 2.0);
            float modulator = sin(t * 0.5) * 0.5 + 0.5;
            return carrier * modulator * 2.0 - 1.0;
            
        } else if (u_waveType < 21.5) {
            // Type 21: Fractal (bruit fractal-like)
            float fractal = 0.0;
            float amplitude = 1.0;
            float frequency = 1.0;
            for (int i = 0; i < 4; i++) {
                fractal += sin(t * frequency) * amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            return fractal * 0.5;
            
        } else {
            // Type 22: Beats (battements interférentiels)
            float f1 = sin(t * 2.0);
            float f2 = sin(t * 2.1); // Légère différence de fréquence
            return (f1 + f2) * 0.5; // Crée des battements
        }
    }
    
    // Fonction pour trouver la courbe la plus proche et calculer la déformation
    vec2 deformUV(vec2 screenUV) {
        // screenUV est la position à l'écran où on veut afficher le pixel
        // On doit trouver quelle ligne de texte devrait être là après déformation
        
        // Calculer l'espacement normal entre les lignes
        float lineHeight = (1.0 / u_numCurves) * u_spacing;
        
        // Calculer l'espacement total disponible et ajuster pour le spacing
        float totalSpacingAdj = 1.0 * (u_spacing - 1.0) / 2.0;
        float adjustedStartOffset = -totalSpacingAdj;
        
        float bestDist = 9999.0;
        float bestLineIndex = 0.0;
        float bestLocalY = 0.5;
        
        // Tester chaque ligne pour trouver celle qui est la plus proche de screenUV.y après déformation
        for (float i = 0.0; i < 20.0; i += 1.0) {
            if (i >= u_numCurves) continue;
            
            float lineIndex = i;
            // Calculer la position de cette ligne avec espacement ajusté
            float lineTop = adjustedStartOffset + lineIndex * lineHeight;
            float lineBottom = adjustedStartOffset + (lineIndex + 1.0) * lineHeight;
            
            // Calculer où cette ligne devrait être après déformation sinusoïdale
            // L'amplitude est en pixels, on la convertit en coordonnées normalisées
            // Phase en radians : u_phase / 360.0 * 2.0 * 3.14159
            // Stagger temporel : chaque ligne a un décalage temporel basé sur son index
            float phaseRad = u_phase / 360.0 * 2.0 * 3.14159;
            float staggerTime = float(lineIndex) * u_timeStagger;
            
            // Appliquer la rotation : transformer les coordonnées selon l'angle de rotation
            float rotationRad = u_rotation / 360.0 * 2.0 * 3.14159;
            float cosR = cos(rotationRad);
            float sinR = sin(rotationRad);
            
            // Coordonnées centrées pour la rotation
            vec2 centeredUV = screenUV - vec2(0.5, 0.5);
            
            // Appliquer la rotation à la matrice pour obtenir la position selon l'axe roté
            vec2 rotatedUV;
            rotatedUV.x = centeredUV.x * cosR - centeredUV.y * sinR;
            rotatedUV.y = centeredUV.x * sinR + centeredUV.y * cosR;
            
            // Calculer l'onde selon l'axe roté (utiliser rotatedUV.x qui est la direction perpendiculaire aux vagues)
            // Remettre dans l'espace original avant de calculer l'onde
            float waveDirection = rotatedUV.x + 0.5;
            float waveAngle = waveDirection * u_frequency * 2.0 * 3.14159 + u_time * 0.5 + phaseRad + staggerTime;
            float waveOffset = waveFunction(waveAngle) * (u_amplitude / u_resolution.y);
            
            // Ajouter le décalage vertical (en coordonnées normalisées)
            float verticalOffsetNorm = u_verticalOffset / u_resolution.y;
            float deformedTop = lineTop + waveOffset + verticalOffsetNorm;
            float deformedBottom = lineBottom + waveOffset + verticalOffsetNorm;
            
            // Vérifier si screenUV.y est dans cette ligne déformée
            if (screenUV.y >= deformedTop && screenUV.y <= deformedBottom) {
                // Calculer la position relative dans la ligne
                float lineHeight_diff = deformedBottom - deformedTop;
                float localY = (screenUV.y - deformedTop) / (lineHeight_diff > 0.001 ? lineHeight_diff : 0.001);
                bestLineIndex = lineIndex;
                bestLocalY = localY;
                bestDist = 0.0;
            }
            
            // Toujours calculer la distance pour trouver la meilleure ligne
            float distTop = abs(screenUV.y - deformedTop);
            float distBottom = abs(screenUV.y - deformedBottom);
            float dist = distTop < distBottom ? distTop : distBottom;
            if (dist < bestDist) {
                bestDist = dist;
                bestLineIndex = lineIndex;
                // Estimer la position relative
                if (deformedBottom > deformedTop) {
                    bestLocalY = clamp((screenUV.y - deformedTop) / (deformedBottom - deformedTop), 0.0, 1.0);
                }
            }
        }
        
        // Augmenter la tolérance pour permettre le débordement en haut et en bas
        // On accepte les pixels même s'ils sont un peu plus loin pour remplir les bords
        if (bestDist > lineHeight * 2.5) {
            return vec2(-1.0, -1.0); // UV invalide pour masquer
        }
        
        // Retourner la position originale dans le canvas texte
        float lineTop = adjustedStartOffset + bestLineIndex * lineHeight;
        float lineBottom = adjustedStartOffset + (bestLineIndex + 1.0) * lineHeight;
        float originalY = lineTop + bestLocalY * (lineBottom - lineTop);
        
        // Convertir en coordonnées UV du canvas texte (0-1)
        float normalizedY = clamp(originalY, 0.0, 1.0);
        
        return vec2(screenUV.x, normalizedY);
    }
    
    
    // Fonction pour convertir RGB en HSV
    vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        
        float d = q.x - min(q.w, q.y);
        float e = 1.0e-10;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }
    
    // Fonction pour convertir HSV en RGB
    vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }
    
    // Fonction pour obtenir une heat map simplifiée avec moins de couleurs
    vec3 getTrueHeatMap(float intensity) {
        // Heat map simplifiée : noir -> bleu -> vert -> jaune -> rouge -> blanc
        // Seulement 5 transitions principales pour un rendu plus épuré
        vec3 color = vec3(0.0);
        
        if (intensity < 0.2) {
            // Noir vers bleu saturé
            float t = intensity / 0.2;
            color = mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), t);
        } else if (intensity < 0.4) {
            // Bleu vers vert saturé
            float t = (intensity - 0.2) / 0.2;
            color = mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), t);
        } else if (intensity < 0.6) {
            // Vert vers jaune saturé
            float t = (intensity - 0.4) / 0.2;
            color = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), t);
        } else if (intensity < 0.8) {
            // Jaune vers rouge saturé
            float t = (intensity - 0.6) / 0.2;
            color = mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), t);
        } else {
            // Rouge vers blanc
            float t = (intensity - 0.8) / 0.2;
            color = mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0), t);
        }
        
        // Augmenter légèrement la saturation pour plus de punch
        vec3 hsv = rgb2hsv(color);
        hsv.y = min(1.0, hsv.y * 1.2); // Augmenter la saturation de 20%
        color = hsv2rgb(hsv);
        
        return color;
    }
    
    
    // Ancienne fonction gardée pour compatibilité (peut être supprimée si non utilisée)
    vec3 heatMapGradient(float intensity) {
        // Palette: rouge -> orange -> jaune -> vert -> cyan -> blanc
        // Pour que les luminance élevées (texte blanc ~1.0) donnent du blanc par défaut
        
        vec3 baseColor;
        
        if (intensity > 0.9) {
            // Luminance très élevée -> blanc directement
            return vec3(1.0, 1.0, 1.0);
        } else if (intensity < 0.166) {
            // Rouge vers orange
            float t = intensity / 0.166;
            baseColor = mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 0.5, 0.0), t);
        } else if (intensity < 0.333) {
            // Orange vers jaune
            float t = (intensity - 0.166) / 0.167;
            baseColor = mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 1.0, 0.0), t);
        } else if (intensity < 0.5) {
            // Jaune vers vert
            float t = (intensity - 0.333) / 0.167;
            baseColor = mix(vec3(1.0, 1.0, 0.0), vec3(0.0, 1.0, 0.5), t);
        } else if (intensity < 0.666) {
            // Vert vers cyan
            float t = (intensity - 0.5) / 0.166;
            baseColor = mix(vec3(0.0, 1.0, 0.5), vec3(0.0, 1.0, 1.0), t);
        } else {
            // Cyan vers blanc
            float t = (intensity - 0.666) / (0.9 - 0.666);
            baseColor = mix(vec3(0.0, 1.0, 1.0), vec3(1.0, 1.0, 1.0), t);
        }
        
        return baseColor;
    }
    
    void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        // Inverser Y pour correspondre au canvas 2D
        uv.y = 1.0 - uv.y;
        
        // Déformer les coordonnées UV selon les courbes sinusoïdales
        vec2 deformedUV = deformUV(uv);
        
        // Si l'UV est invalide (trop loin de toute ligne), rendre le fond
        if (deformedUV.x < 0.0 || deformedUV.y < 0.0) {
            if (u_heatMapEnabled > 0.5 && u_motionBlur > 0.01) {
                // Pour le fond, on peut utiliser la position Y pour créer un gradient vertical
                // ou laisser le fond normal selon les préférences
                float backgroundIntensity = uv.y; // Utiliser la position Y comme intensité
                
                // Appliquer la heat map
                vec3 heatMapBgColor = getTrueHeatMap(backgroundIntensity);
                
                // Appliquer la rotation de hue
                vec3 hsv = rgb2hsv(heatMapBgColor);
                hsv.x = mod(hsv.x + u_hue / 360.0, 1.0);
                vec3 finalBgColor = hsv2rgb(hsv);
                
                gl_FragColor = vec4(finalBgColor, 1.0);
            } else {
                // Fond normal - utiliser la couleur de fond sélectionnée
                gl_FragColor = vec4(u_backgroundColor, 1.0);
            }
            return;
        }
        
        // Lire la couleur de base du texte
        vec3 baseColor = texture2D(u_texture, deformedUV).rgb;
        
        // Si le pixel est transparent/noir, afficher le fond
        if (dot(baseColor, vec3(1.0)) < 0.01) {
            // Afficher la couleur de fond
            gl_FragColor = vec4(u_backgroundColor, 1.0);
            return;
        }
        
        // Calculer la luminance de base
        float baseLuminance = dot(baseColor, vec3(0.299, 0.587, 0.114));
        
        
        // Appliquer le flou directionnel de façon optimale
        vec3 blurredColor = baseColor;
        
        if (u_motionBlur > 0.01) {
            // Direction du flou : vers la gauche (le texte se déplace vers la droite)
            float blurAmount = u_motionBlur / u_resolution.x;
            vec2 blurDir = vec2(-1.0, 0.0); // Direction vers la gauche
            float numSamplesF = min(u_motionBlur * 2.5, 25.0);
            
            float totalWeight = 0.0;
            vec3 tempBlurredColor = vec3(0.0);
            
            // Échantillonner dans la direction du flou
            for (int i = 0; i < 25; i++) {
                if (float(i) >= numSamplesF) continue;
                
                float t = float(i) / (numSamplesF > 1.0 ? (numSamplesF - 1.0) : 1.0);
                vec2 offset = blurDir * blurAmount * t;
                vec2 sampleUV = deformedUV + offset;
                
                // Clamper les UV
                sampleUV = clamp(sampleUV, vec2(0.0), vec2(1.0));
                
                // Lire la couleur à cette position
                vec3 sampleColor = texture2D(u_texture, sampleUV).rgb;
                
                // Poids gaussien décroissant exponentiellement
                float weight = exp(-t * t * 4.0);
                tempBlurredColor += sampleColor * weight;
                totalWeight += weight;
            }
            
            // Normaliser
            if (totalWeight > 0.001) {
                blurredColor = tempBlurredColor / totalWeight;
            }
        }
        
        // Appliquer la gradient map sur le flou si la heat map est activée
        vec3 finalOutputColor;
        
        if (u_heatMapEnabled > 0.5 && u_motionBlur > 0.01) {
            // Calculer la luminance du flou
            float blurredLuminance = dot(blurredColor, vec3(0.299, 0.587, 0.114));
            
            // Appliquer la gradient map basée sur la luminance
            vec3 heatMapColor = getTrueHeatMap(blurredLuminance);
            vec3 heatMapHsv = rgb2hsv(heatMapColor);
            heatMapHsv.x = mod(heatMapHsv.x + u_hue / 360.0, 1.0);
            finalOutputColor = hsv2rgb(heatMapHsv);
        } else {
            // Sans heat map
            if (u_preserveImageColor > 0.5) {
                // Préserver les couleurs de la source (utile pour imageMode)
                finalOutputColor = blurredColor;
            } else {
                // Utiliser la couleur du texte sélectionnée (mode texte)
                vec3 hsv = rgb2hsv(u_textColor);
                hsv.x = mod(hsv.x + u_hue / 360.0, 1.0);
                vec3 textColor = hsv2rgb(hsv);
                float finalLuminance = dot(blurredColor, vec3(0.299, 0.587, 0.114));
                finalOutputColor = textColor * finalLuminance;
            }
        }
        
        // Appliquer le grain si activé
        if (u_grain > 0.01) {
            // Générer du bruit multi-octave pour un grain réaliste
            float grainNoise = 0.0;
            float amplitude = 1.0;
            float frequency = 1.0;
            
            for (int i = 0; i < 4; i++) {
                grainNoise += noise(gl_FragCoord.xy * frequency * 0.01) * amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            
            // Normaliser le bruit entre -1 et 1
            grainNoise = grainNoise * 2.0 - 1.0;
            
            // Appliquer le grain avec l'intensité contrôlée
            float grainIntensity = u_grain / 100.0;
            vec3 grainColor = finalOutputColor + grainNoise * grainIntensity * 0.3;
            
            // Ajouter de la variation de luminosité pour un effet plus grunge
            float luminanceVariation = noise(gl_FragCoord.xy * 0.02 + u_time * 0.1) * grainIntensity * 0.2;
            grainColor = grainColor * (1.0 + luminanceVariation);
            
            gl_FragColor = vec4(grainColor, 1.0);
        } else {
            gl_FragColor = vec4(finalOutputColor, 1.0);
        }
    }
`;

    // Fonction pour créer et compiler un shader
    function createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Erreur de compilation shader:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        
        return shader;
    }

    // Fonction pour créer un programme shader
    function createProgram(gl, vertexShader, fragmentShader) {
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Erreur de liaison programme:', gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return null;
        }
        
        return program;
    }

    // Créer les shaders et le programme
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    
    if (!vertexShader || !fragmentShader) {
        console.error('Erreur lors de la compilation des shaders');
        return;
    }
    
    const program = createProgram(gl, vertexShader, fragmentShader);
    
    if (!program) {
        console.error('Erreur lors de la création du programme shader');
        return;
    }

    // Créer un buffer pour un rectangle plein écran
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const positions = [
        -1, -1,
         1, -1,
        -1,  1,
         1,  1,
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    // Configuration du programme
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    
    // Texture pour le canvas texte
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); // Plus net pour le texte
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // Plus net pour le texte
    
    
    // Trouver les locations des uniforms
    const textureLocation = gl.getUniformLocation(program, 'u_texture');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const frequencyLocation = gl.getUniformLocation(program, 'u_frequency');
    const amplitudeLocation = gl.getUniformLocation(program, 'u_amplitude');
    const numCurvesLocation = gl.getUniformLocation(program, 'u_numCurves');
    const spacingLocation = gl.getUniformLocation(program, 'u_spacing');
    const hueLocation = gl.getUniformLocation(program, 'u_hue');
    const motionBlurLocation = gl.getUniformLocation(program, 'u_motionBlur');
    const phaseLocation = gl.getUniformLocation(program, 'u_phase');
    const waveTypeLocation = gl.getUniformLocation(program, 'u_waveType');
    const rotationLocation = gl.getUniformLocation(program, 'u_rotation');
    const verticalOffsetLocation = gl.getUniformLocation(program, 'u_verticalOffset');
    const timeStaggerLocation = gl.getUniformLocation(program, 'u_timeStagger');
    const heatMapEnabledLocation = gl.getUniformLocation(program, 'u_heatMapEnabled');
    const grainLocation = gl.getUniformLocation(program, 'u_grain');
    const textColorLocation = gl.getUniformLocation(program, 'u_textColor');
    const backgroundColorLocation = gl.getUniformLocation(program, 'u_backgroundColor');
    const preserveImageColorLocation = gl.getUniformLocation(program, 'u_preserveImageColor');

    // Fonction pour convertir hex en RGB
    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255
        ] : [1, 1, 1];
    }

    // Fonction pour convertir RGB (0-1) en hex #RRGGBB
    function rgbToHex(rgbArr) {
        function toHex(v) {
            const n = Math.max(0, Math.min(255, Math.round(v * 255)));
            return n.toString(16).padStart(2, '0');
        }
        return `#${toHex(rgbArr[0])}${toHex(rgbArr[1])}${toHex(rgbArr[2])}`;
    }

    // Le canvas texte est déjà créé plus haut, maintenant on configure juste ses dimensions
    const dpr = window.devicePixelRatio || 1;
    let textCanvasScaled = false;
    
    function setupTextCanvas() {
        if (!textCanvasScaled) {
            textCanvas.width = canvas.width * dpr;
            textCanvas.height = canvas.height * dpr;
            textCanvas.style.width = canvas.width + 'px';
            textCanvas.style.height = canvas.height + 'px';
            textCtx.scale(dpr, dpr);
            
            // Configurer le rendu haute qualité
            textCtx.imageSmoothingEnabled = true;
            textCtx.imageSmoothingQuality = 'high';
            
            textCanvasScaled = true;
        }
    }
    setupTextCanvas();

    // Cache pour le canvas temporaire du texte (optimisation)
    let cachedTextCanvas = null;
    let cachedTextOld = '';
    let cachedTextSizeOld = 0;
    let cachedTextValue = '';
    
    // Fonction pour obtenir ou créer le canvas temporaire du texte (haute résolution)
    function getTextCanvas(text, fontSize, textCtx) {
        // Réutiliser le canvas si le texte et la taille n'ont pas changé
        if (cachedTextCanvas && cachedTextOld === text && cachedTextSizeOld === fontSize) {
            return cachedTextCanvas;
        }
        
        // Créer un nouveau canvas temporaire en haute résolution
        const dpr = window.devicePixelRatio || 2; // Utiliser devicePixelRatio pour netteté
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.font = `bold ${fontSize}px Arial`;
        const textWidth = tempCtx.measureText(text).width;
        const textHeight = fontSize * 1.5;
        
        // Canvas haute résolution
        tempCanvas.width = (textWidth + 40) * dpr;
        tempCanvas.height = (textHeight + 40) * dpr;
        
        // Mettre à l'échelle le contexte pour la haute résolution
        tempCtx.scale(dpr, dpr);
        
        // Dessiner le texte sur le canvas temporaire (centré)
        tempCtx.font = `bold ${fontSize}px Arial`;
        tempCtx.fillStyle = textCtx.fillStyle;
        tempCtx.textAlign = 'center';
        tempCtx.textBaseline = 'middle';
        tempCtx.shadowColor = textCtx.shadowColor;
        tempCtx.shadowBlur = textCtx.shadowBlur;
        tempCtx.fillText(text, (tempCanvas.width / dpr) / 2, (tempCanvas.height / dpr) / 2);
        
        // Sauvegarder le DPR pour utilisation ultérieure
        tempCanvas._dpr = dpr;
        tempCanvas._logicalWidth = textWidth + 40;
        tempCanvas._logicalHeight = textHeight + 40;
        
        // Mettre en cache
        cachedTextCanvas = tempCanvas;
        cachedTextValue = text;
        cachedTextSizeValue = fontSize;
        
        return tempCanvas;
    }

    // Fonction pour dessiner le texte déformé selon la courbe (approche fluide et optimisée)
    function drawDistortedText(text, x, y, baseY, textCtx) {
        // Dessiner le texte caractère par caractère avec transformation fluide
        const chars = text.split('');
        const freqMult = uniforms.frequency * Math.PI * 2;
        const canvasWidthInv = 1 / canvas.width;
        let currentX = x;
        
        // Sauvegarder le contexte
        const prevFont = textCtx.font;
        const prevFillStyle = textCtx.fillStyle;
        const prevTextAlign = textCtx.textAlign;
        const prevTextBaseline = textCtx.textBaseline;
        const prevShadowColor = textCtx.shadowColor;
        const prevShadowBlur = textCtx.shadowBlur;
        
        // Configurer pour le rendu haute qualité avec la police sélectionnée
        textCtx.font = `bold ${textData.size}px ${textData.fontFamily}`;
        textCtx.fillStyle = prevFillStyle;
        textCtx.textAlign = 'left';
        textCtx.textBaseline = 'middle';
        
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const charWidth = textCtx.measureText(char).width;
            const charCenterX = currentX + charWidth * 0.5;
            
            // Calculer la position Y selon la courbe
            const normalizedX = charCenterX * canvasWidthInv;
            const curveOffset = Math.sin(normalizedX * freqMult + uniforms.time) * uniforms.amplitude;
            const curveY = baseY + curveOffset;
            
            // Calculer l'angle de la tangente pour rotation optionnelle (peut être commenté pour garder horizontal)
            // const angle = Math.cos(normalizedX * freqMult + uniforms.time) * freqMult * uniforms.amplitude * canvasWidthInv;
            
            // Dessiner le caractère avec transformation
            textCtx.save();
            textCtx.translate(charCenterX, curveY);
            // textCtx.rotate(angle); // Décommenter pour rotation selon la courbe
            textCtx.fillText(char, -charWidth * 0.5, 0);
            textCtx.restore();
            
            currentX += charWidth;
        }
        
        // Restaurer le contexte
        textCtx.font = prevFont;
        textCtx.fillStyle = prevFillStyle;
        textCtx.textAlign = prevTextAlign;
        textCtx.textBaseline = prevTextBaseline;
        textCtx.shadowColor = prevShadowColor;
        textCtx.shadowBlur = prevShadowBlur;
    }

    // Fonction pour calculer la couleur de glow (optimisée)
    function getGlowColor(normalizedX, color1, color2) {
        const colorMix = (normalizedX + 1) * 0.5;
        const r = Math.floor(color1[0] * 255 * (1 - colorMix) + color2[0] * 255 * colorMix);
        const g = Math.floor(color1[1] * 255 * (1 - colorMix) + color2[1] * 255 * colorMix);
        const b = Math.floor(color1[2] * 255 * (1 - colorMix) + color2[2] * 255 * colorMix);
        return `rgb(${r},${g},${b})`;
    }

    // Cache pour éviter les recalculs
    let cachedLineHeight = 0;
    let cachedTotalSpacing = 0;
    let cachedAdjustedStartOffset = 0;
    let cachedFontFamily = '';
    let cachedNumCurves = 0;
    let cachedEntriesKey = '';
    let cachedTextSizeValue = 0;
    let cachedSanitizedEntries = ['SINUS'];
    let cachedEntryMetrics = [];
    let textCacheDirty = true;

    const ENTRY_SEPARATOR = '\u0001';

    function sanitizeEntries(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return ['SINUS'];
        }
        return entries.map((entry) => {
            if (typeof entry !== 'string') {
                return ' ';
            }
            const hasContent = entry.trim().length > 0;
            return hasContent ? entry : ' ';
        });
    }

    function ensureTextContextStyle(ctx) {
        ctx.font = `bold ${textData.size}px ${textData.fontFamily}`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
    }

    function computeEntryMetrics(ctx, entries, canvasWidth) {
        return entries.map((text) => {
            const width = Math.max(1, ctx.measureText(text).width || 0.0001);
            return {
                width,
                repetitions: Math.ceil(canvasWidth / width) + 2
            };
        });
    }

    function invalidateTextCache() {
        textCacheDirty = true;
    }

    // Fonction pour dessiner le texte sur le canvas 2D séparé (simple et rectiligne - la déformation se fait dans le shader)
    function renderText() {
        // Ne réinitialiser le canvas que si la taille a changé
        const dpr = window.devicePixelRatio || 1;
        const shouldResize = textCanvas.width !== canvas.width * dpr || textCanvas.height !== canvas.height * dpr;

        if (shouldResize) {
            textCanvasScaled = false;
            setupTextCanvas();
            textCacheDirty = true;
        }

        // Le contexte est déjà mis à l'échelle avec DPR dans setupTextCanvas
        // Donc on utilise les coordonnées en pixels logiques (canvas.width/height)
        textCtx.clearRect(0, 0, canvas.width, canvas.height);

        // Si imageMode, dessiner l'image et sortir (pas de texte)
        if (imageMode && loadedImage) {
            // Fit l'image dans le canvas en couvrant (cover) pour éviter les bandes
            const canvasW = canvas.width;
            const canvasH = canvas.height;
            const imgW = loadedImage.naturalWidth || loadedImage.width;
            const imgH = loadedImage.naturalHeight || loadedImage.height;
            const scale = Math.max(canvasW / imgW, canvasH / imgH);
            const drawW = imgW * scale;
            const drawH = imgH * scale;
            const dx = (canvasW - drawW) / 2;
            const dy = (canvasH - drawH) / 2;
            textCtx.drawImage(loadedImage, dx, dy, drawW, drawH);
            return;
        }

        ensureTextContextStyle(textCtx);

        const numCurves = uniforms.numCurves;
        const sanitizedEntries = sanitizeEntries(textData.entries);
        const entriesKey = sanitizedEntries.join(ENTRY_SEPARATOR);
        const spacingOffset = canvas.height * (uniforms.spacing - 1.0) / 2.0;

        const shouldRecalculate = textCacheDirty ||
                                 cachedEntriesKey !== entriesKey ||
                                 cachedTextSizeValue !== textData.size ||
                                 cachedFontFamily !== textData.fontFamily ||
                                 cachedNumCurves !== numCurves ||
                                 Math.abs(cachedTotalSpacing - spacingOffset) > 0.001;

        if (shouldRecalculate) {
            cachedSanitizedEntries = sanitizedEntries;
            cachedEntryMetrics = computeEntryMetrics(textCtx, sanitizedEntries, canvas.width);
            cachedLineHeight = (canvas.height / numCurves) * uniforms.spacing;
            cachedTotalSpacing = spacingOffset;
            cachedAdjustedStartOffset = -cachedTotalSpacing;
            cachedEntriesKey = entriesKey;
            cachedTextSizeValue = textData.size;
            cachedFontFamily = textData.fontFamily;
            cachedNumCurves = numCurves;
            textCacheDirty = false;
        }

        const speed = uniforms.speed * 100;
        const metricsLookup = cachedEntryMetrics.map((metric) => {
            const length = metric.width;
            const offset = (uniforms.time * speed) % length;
            const baseX = -length + offset;
            const firstVisibleIndex = Math.max(0, Math.floor(-baseX / length));
            const lastVisibleIndex = Math.min(metric.repetitions, Math.ceil((canvas.width - baseX) / length) + 1);
            return { baseX, firstVisibleIndex, lastVisibleIndex, length };
        });

        for (let i = 0; i < numCurves; i++) {
            const entryIndex = i % cachedSanitizedEntries.length;
            const metric = metricsLookup[entryIndex];
            if (!metric) {
                continue;
            }
            const yPos = cachedAdjustedStartOffset + i * cachedLineHeight + cachedLineHeight / 2;

            for (let r = metric.firstVisibleIndex; r < metric.lastVisibleIndex; r++) {
                const xPos = metric.baseX + r * metric.length;

                if (xPos + metric.length >= 0 && xPos <= canvas.width) {
                    textCtx.fillText(cachedSanitizedEntries[entryIndex], xPos, yPos);
                }
            }
        }
    }

    // Fonction pour mettre à jour la texture depuis le canvas texte
    function updateTexture() {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
    }
    
    // Activer le mélange alpha pour voir le fond à travers les zones transparentes
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    // Fonction de rendu combinée (optimisée)
    let lastTime = performance.now();
    let lastTextUpdate = 0;
    const TEXT_UPDATE_INTERVAL = 16; // Mettre à jour le texte toutes les 16ms (60fps max)
    
    function renderCombined(currentTime) {
        // Calculer le delta time pour une animation plus fluide
        const deltaTime = currentTime ? (currentTime - lastTime) / 1000 : 0.016;
        lastTime = currentTime || performance.now();
        
        uniforms.time += deltaTime;
        uniforms.resolution = [canvas.width, canvas.height];
        
        // Optimisation : ne mettre à jour le texte que si nécessaire
        const shouldUpdateText = (currentTime - lastTextUpdate) >= TEXT_UPDATE_INTERVAL;
        
        if (shouldUpdateText) {
            // Rendre le texte sur le canvas 2D
            renderText();
            
            // Mettre à jour la texture WebGL avec le canvas texte
            updateTexture();
            
            lastTextUpdate = currentTime;
        }
        
        // Rendre WebGL avec le shader de post-processing
        // Toujours utiliser la couleur de fond sélectionnée
        const bgColor = uniforms.backgroundColor;
        gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        // Activer le programme shader
        gl.useProgram(program);
        
        // Configurer les attributs
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
        
        // Configurer la texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(textureLocation, 0);
        
        // Configurer les uniforms
        gl.uniform2fv(resolutionLocation, uniforms.resolution);
        gl.uniform1f(timeLocation, uniforms.time);
        gl.uniform1f(frequencyLocation, uniforms.frequency);
        gl.uniform1f(amplitudeLocation, uniforms.amplitude);
        gl.uniform1f(numCurvesLocation, uniforms.numCurves);
        gl.uniform1f(spacingLocation, uniforms.spacing);
        gl.uniform1f(hueLocation, uniforms.hue);
        gl.uniform1f(motionBlurLocation, uniforms.motionBlur);
        gl.uniform1f(phaseLocation, uniforms.phase);
        gl.uniform1f(waveTypeLocation, uniforms.waveType);
        gl.uniform1f(rotationLocation, uniforms.rotation);
        gl.uniform1f(verticalOffsetLocation, uniforms.verticalOffset);
        gl.uniform1f(timeStaggerLocation, uniforms.timeStagger);
        gl.uniform1f(heatMapEnabledLocation, uniforms.heatMapEnabled);
        gl.uniform1f(grainLocation, uniforms.grain);
        gl.uniform3f(textColorLocation, uniforms.textColor[0], uniforms.textColor[1], uniforms.textColor[2]);
        gl.uniform3f(backgroundColorLocation, uniforms.backgroundColor[0], uniforms.backgroundColor[1], uniforms.backgroundColor[2]);
        gl.uniform1f(preserveImageColorLocation, uniforms.preserveImageColor);
        
        
        // Dessiner
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        
        requestAnimationFrame(renderCombined);
    }

    const MAX_ANIMATION_FPS = 240;
    const MAX_GIF_DURATION_SECONDS = 10;
    const MAX_GIF_FRAMES = MAX_GIF_DURATION_SECONDS * MAX_ANIMATION_FPS;
    const MAX_VIDEO_DURATION_SECONDS = 20;
    const MAX_VIDEO_FRAMES = MAX_VIDEO_DURATION_SECONDS * MAX_ANIMATION_FPS;
    const VIDEO_MIME_CANDIDATES = [
        'video/mp4;codecs="h264"',
        'video/webm;codecs="vp9"',
        'video/webm;codecs="vp8"',
        'video/webm'
    ];

    function createHighQualityRenderer(qualityFactor = 4) {
        const exportWidth = Math.max(1, Math.round(canvas.width * qualityFactor));
        const exportHeight = Math.max(1, Math.round(canvas.height * qualityFactor));

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = exportWidth;
        exportCanvas.height = exportHeight;

        const exportGl = exportCanvas.getContext('webgl');
        if (!exportGl) {
            throw new Error('WebGL not supported for export');
        }

        const exportVertexShader = createShader(exportGl, exportGl.VERTEX_SHADER, vertexShaderSource);
        const exportFragmentShader = createShader(exportGl, exportGl.FRAGMENT_SHADER, fragmentShaderSource);
        const exportProgram = createProgram(exportGl, exportVertexShader, exportFragmentShader);

        if (!exportProgram) {
            throw new Error('Failed to create export program');
        }

        const exportPositionBuffer = exportGl.createBuffer();
        exportGl.bindBuffer(exportGl.ARRAY_BUFFER, exportPositionBuffer);
        exportGl.bufferData(exportGl.ARRAY_BUFFER, new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
             1,  1
        ]), exportGl.STATIC_DRAW);

        const exportTextCanvas = document.createElement('canvas');
        exportTextCanvas.width = exportWidth;
        exportTextCanvas.height = exportHeight;
        const exportTextCtx = exportTextCanvas.getContext('2d');
        exportTextCtx.imageSmoothingEnabled = true;
        exportTextCtx.imageSmoothingQuality = 'high';
        exportTextCtx.setTransform(qualityFactor, 0, 0, qualityFactor, 0, 0);

        const exportTexture = exportGl.createTexture();
        exportGl.bindTexture(exportGl.TEXTURE_2D, exportTexture);
        exportGl.texParameteri(exportGl.TEXTURE_2D, exportGl.TEXTURE_WRAP_S, exportGl.CLAMP_TO_EDGE);
        exportGl.texParameteri(exportGl.TEXTURE_2D, exportGl.TEXTURE_WRAP_T, exportGl.CLAMP_TO_EDGE);
        exportGl.texParameteri(exportGl.TEXTURE_2D, exportGl.TEXTURE_MIN_FILTER, exportGl.NEAREST);
        exportGl.texParameteri(exportGl.TEXTURE_2D, exportGl.TEXTURE_MAG_FILTER, exportGl.NEAREST);

        const exportPositionLocation = exportGl.getAttribLocation(exportProgram, 'a_position');
        exportGl.enableVertexAttribArray(exportPositionLocation);
        exportGl.bindBuffer(exportGl.ARRAY_BUFFER, exportPositionBuffer);
        exportGl.vertexAttribPointer(exportPositionLocation, 2, exportGl.FLOAT, false, 0, 0);

        const uniformLocations = {
            texture: exportGl.getUniformLocation(exportProgram, 'u_texture'),
            resolution: exportGl.getUniformLocation(exportProgram, 'u_resolution'),
            time: exportGl.getUniformLocation(exportProgram, 'u_time'),
            frequency: exportGl.getUniformLocation(exportProgram, 'u_frequency'),
            amplitude: exportGl.getUniformLocation(exportProgram, 'u_amplitude'),
            numCurves: exportGl.getUniformLocation(exportProgram, 'u_numCurves'),
            spacing: exportGl.getUniformLocation(exportProgram, 'u_spacing'),
            hue: exportGl.getUniformLocation(exportProgram, 'u_hue'),
            motionBlur: exportGl.getUniformLocation(exportProgram, 'u_motionBlur'),
            phase: exportGl.getUniformLocation(exportProgram, 'u_phase'),
            waveType: exportGl.getUniformLocation(exportProgram, 'u_waveType'),
            rotation: exportGl.getUniformLocation(exportProgram, 'u_rotation'),
            verticalOffset: exportGl.getUniformLocation(exportProgram, 'u_verticalOffset'),
            timeStagger: exportGl.getUniformLocation(exportProgram, 'u_timeStagger'),
            heatMapEnabled: exportGl.getUniformLocation(exportProgram, 'u_heatMapEnabled'),
            grain: exportGl.getUniformLocation(exportProgram, 'u_grain'),
            textColor: exportGl.getUniformLocation(exportProgram, 'u_textColor'),
            backgroundColor: exportGl.getUniformLocation(exportProgram, 'u_backgroundColor'),
            preserveImageColor: exportGl.getUniformLocation(exportProgram, 'u_preserveImageColor')
        };

        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = exportWidth;
        finalCanvas.height = exportHeight;
        const finalCtx = finalCanvas.getContext('2d');

        const pixels = new Uint8Array(exportWidth * exportHeight * 4);
        const imageData = finalCtx.createImageData(exportWidth, exportHeight);
        const rowSize = exportWidth * 4;

        function renderSource(timeValue, renderCache) {
            exportTextCtx.setTransform(qualityFactor, 0, 0, qualityFactor, 0, 0);
            exportTextCtx.clearRect(0, 0, canvas.width, canvas.height);

            if (imageMode && loadedImage) {
                const imgW = loadedImage.naturalWidth || loadedImage.width;
                const imgH = loadedImage.naturalHeight || loadedImage.height;
                const baseW = canvas.width;
                const baseH = canvas.height;
                const scale = Math.max(baseW / imgW, baseH / imgH);
                const drawW = imgW * scale;
                const drawH = imgH * scale;
                const dx = (baseW - drawW) / 2;
                const dy = (baseH - drawH) / 2;
                exportTextCtx.drawImage(loadedImage, dx, dy, drawW, drawH);
                return;
            }

            ensureTextContextStyle(exportTextCtx);

            const cache = renderCache && !renderCache.isImage ? renderCache : null;
            const numCurves = cache ? cache.numCurves : uniforms.numCurves;
            const exportSanitizedEntries = cache ? cache.sanitizedEntries : sanitizeEntries(textData.entries);
            const exportMetrics = cache ? cache.metrics : computeEntryMetrics(exportTextCtx, exportSanitizedEntries, canvas.width);
            const exportSpeed = uniforms.speed * 100;
            const exportMetricLookup = exportMetrics.map((metric) => {
                const length = metric.width;
                const offset = (timeValue * exportSpeed) % length;
                const baseX = -length + offset;
                const firstVisibleIndex = Math.max(0, Math.floor(-baseX / length));
                const lastVisibleIndex = Math.min(metric.repetitions, Math.ceil((canvas.width - baseX) / length) + 1);
                return { baseX, firstVisibleIndex, lastVisibleIndex, length };
            });

            const exportLineHeight = cache ? cache.lineHeight : (canvas.height / numCurves) * uniforms.spacing;
            const exportAdjustedStartOffset = cache ? cache.adjustedStartOffset : -(
                canvas.height * (uniforms.spacing - 1.0) / 2.0
            );

            for (let i = 0; i < numCurves; i++) {
                const entryIndex = i % exportSanitizedEntries.length;
                const metric = exportMetricLookup[entryIndex];
                if (!metric) {
                    continue;
                }
                const yPos = exportAdjustedStartOffset + i * exportLineHeight + exportLineHeight / 2;
                for (let r = metric.firstVisibleIndex; r < metric.lastVisibleIndex; r++) {
                    const xPos = metric.baseX + r * metric.length;
                    if (xPos + metric.length >= 0 && xPos <= canvas.width) {
                        exportTextCtx.fillText(exportSanitizedEntries[entryIndex], xPos, yPos);
                    }
                }
            }
        }

        function renderFrame(timeValue, renderCache) {
            renderSource(timeValue, renderCache);

            exportGl.activeTexture(exportGl.TEXTURE0);
            exportGl.bindTexture(exportGl.TEXTURE_2D, exportTexture);
            exportGl.texImage2D(exportGl.TEXTURE_2D, 0, exportGl.RGBA, exportGl.RGBA, exportGl.UNSIGNED_BYTE, exportTextCanvas);

            exportGl.viewport(0, 0, exportWidth, exportHeight);
            exportGl.useProgram(exportProgram);

            exportGl.uniform1i(uniformLocations.texture, 0);
            exportGl.uniform2fv(uniformLocations.resolution, [exportWidth, exportHeight]);
            exportGl.uniform1f(uniformLocations.time, timeValue);
            exportGl.uniform1f(uniformLocations.frequency, uniforms.frequency);
            exportGl.uniform1f(uniformLocations.amplitude, uniforms.amplitude * qualityFactor);
            exportGl.uniform1f(uniformLocations.numCurves, uniforms.numCurves);
            exportGl.uniform1f(uniformLocations.spacing, uniforms.spacing);
            exportGl.uniform1f(uniformLocations.hue, uniforms.hue);
            exportGl.uniform1f(uniformLocations.motionBlur, uniforms.motionBlur);
            exportGl.uniform1f(uniformLocations.phase, uniforms.phase);
            exportGl.uniform1f(uniformLocations.waveType, uniforms.waveType);
            exportGl.uniform1f(uniformLocations.rotation, uniforms.rotation);
            exportGl.uniform1f(uniformLocations.verticalOffset, uniforms.verticalOffset * qualityFactor);
            exportGl.uniform1f(uniformLocations.timeStagger, uniforms.timeStagger);
            exportGl.uniform1f(uniformLocations.heatMapEnabled, uniforms.heatMapEnabled);
            exportGl.uniform1f(uniformLocations.grain, uniforms.grain);
            exportGl.uniform3f(uniformLocations.textColor, uniforms.textColor[0], uniforms.textColor[1], uniforms.textColor[2]);
            exportGl.uniform3f(uniformLocations.backgroundColor, uniforms.backgroundColor[0], uniforms.backgroundColor[1], uniforms.backgroundColor[2]);
            exportGl.uniform1f(uniformLocations.preserveImageColor, uniforms.preserveImageColor);

            exportGl.clearColor(uniforms.backgroundColor[0], uniforms.backgroundColor[1], uniforms.backgroundColor[2], 1.0);
            exportGl.clear(exportGl.COLOR_BUFFER_BIT);
            exportGl.drawArrays(exportGl.TRIANGLE_STRIP, 0, 4);

            exportGl.readPixels(0, 0, exportWidth, exportHeight, exportGl.RGBA, exportGl.UNSIGNED_BYTE, pixels);

            for (let y = 0; y < exportHeight; y++) {
                const srcIndex = (exportHeight - 1 - y) * rowSize;
                const dstIndex = y * rowSize;
                imageData.data.set(pixels.subarray(srcIndex, srcIndex + rowSize), dstIndex);
            }

            finalCtx.putImageData(imageData, 0, 0);

            return finalCanvas;
        }

        function createRenderCache() {
            if (imageMode && loadedImage) {
                return { isImage: true };
            }

            ensureTextContextStyle(exportTextCtx);

            const sanitizedEntries = sanitizeEntries(textData.entries);
            const metrics = computeEntryMetrics(exportTextCtx, sanitizedEntries, canvas.width);
            const numCurves = uniforms.numCurves;
            const lineHeight = (canvas.height / numCurves) * uniforms.spacing;
            const totalSpacing = canvas.height * (uniforms.spacing - 1.0) / 2.0;
            const adjustedStartOffset = -totalSpacing;

            return {
                isImage: false,
                sanitizedEntries,
                metrics,
                numCurves,
                lineHeight,
                adjustedStartOffset
            };
        }

        function dispose() {
            exportGl.deleteTexture(exportTexture);
            exportGl.deleteBuffer(exportPositionBuffer);
            exportGl.deleteProgram(exportProgram);
            exportGl.deleteShader(exportVertexShader);
            exportGl.deleteShader(exportFragmentShader);
        }

        return {
            renderFrame,
            dispose,
            width: exportWidth,
            height: exportHeight,
            canvas: finalCanvas,
            context: finalCtx,
            createRenderCache
        };
    }

    // Fonction pour exporter en haute qualité
    async function exportHighQuality() {
        const exportBtn = document.getElementById('exportBtn');
        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting...';

        const savedTime = uniforms.time;
        const savedResolution = uniforms.resolution;

        let exporter;
        try {
            exporter = createHighQualityRenderer(4);
            const renderCache = exporter.createRenderCache();
            exporter.renderFrame(savedTime, renderCache);

            const blob = await new Promise((resolve, reject) => {
                exporter.canvas.toBlob((result) => {
                    if (!result) {
                        reject(new Error('PNG generation failed'));
                        return;
                    }
                    resolve(result);
                }, 'image/png');
            });

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sinus-gradient-${Date.now()}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            exportBtn.disabled = false;
            exportBtn.textContent = 'Export High Quality';
        } catch (error) {
            console.error('Export error:', error);
            alert('Error exporting image: ' + error.message);
            exportBtn.disabled = false;
            exportBtn.textContent = 'Export High Quality';
        } finally {
            if (exporter) {
                exporter.dispose();
            }
            uniforms.time = savedTime;
            uniforms.resolution = savedResolution;
        }
    }

    function getAnimationParameters({ maxDurationSeconds, maxFrames }) {
        const durationInput = document.getElementById('gifDuration');
        const fpsInput = document.getElementById('gifFps');

        const requestedDuration = durationInput ? parseFloat(durationInput.value) : NaN;
        const requestedFps = fpsInput ? parseInt(fpsInput.value, 10) : NaN;

        const durationSeconds = Math.min(
            maxDurationSeconds,
            Math.max(0.5, Number.isFinite(requestedDuration) ? requestedDuration : 4)
        );
        const framesPerSecond = Math.min(
            MAX_ANIMATION_FPS,
            Math.max(1, Number.isFinite(requestedFps) ? requestedFps : 90)
        );

        if (durationInput) {
            durationInput.value = durationSeconds.toString();
        }
        if (fpsInput) {
            fpsInput.value = framesPerSecond.toString();
        }

        const totalFrames = Math.round(durationSeconds * framesPerSecond);
        if (totalFrames > maxFrames) {
            return {
                error: `La combinaison durée (${durationSeconds.toFixed(2)}s) et FPS (${framesPerSecond}) dépasse la limite de ${maxFrames} images.`
            };
        }

        return { durationSeconds, framesPerSecond, totalFrames };
    }

    async function exportHighQualityGIF() {
        const gifBtn = document.getElementById('exportGifBtn');
        if (!gifBtn) {
            return;
        }

        const animationParams = getAnimationParameters({
            maxDurationSeconds: MAX_GIF_DURATION_SECONDS,
            maxFrames: MAX_GIF_FRAMES
        });
        if (!animationParams || animationParams.error) {
            alert(animationParams ? animationParams.error : 'Paramètres GIF invalides.');
            return;
        }

        const { durationSeconds, framesPerSecond, totalFrames } = animationParams;
        const gifFpsClamped = framesPerSecond > 100;

        gifBtn.disabled = true;
        gifBtn.textContent = 'Préparation...';

        const savedTime = uniforms.time;
        const savedResolution = uniforms.resolution;

        let exporter;
        try {
            const qualityFactor = 3;
            exporter = createHighQualityRenderer(qualityFactor);
            const renderCache = exporter.createRenderCache();
            const effectiveGifFps = Math.min(framesPerSecond, 100);
            const frameDelay = 1000 / effectiveGifFps;

            if (typeof GIF !== 'function') {
                throw new Error('La bibliothèque GIF est introuvable');
            }

            const workerScriptUrl = await ensureGifWorkerUrl();
            const workerCount = Math.min(
                8,
                Math.max(2, navigator.hardwareConcurrency ? Math.ceil(navigator.hardwareConcurrency / 2) : 4)
            );

            const gif = new GIF({
                workers: workerCount,
                quality: Math.max(1, Math.round(20 / qualityFactor)),
                workerScript: workerScriptUrl,
                width: exporter.width,
                height: exporter.height
            });

            gif.on('progress', (progress) => {
                const percent = Math.min(100, Math.max(0, Math.round(progress * 100)));
                gifBtn.textContent = `Encodage GIF ${percent}%`;
            });

            const startTime = savedTime;

            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                const frameTime = startTime + frameIndex / framesPerSecond;
                exporter.renderFrame(frameTime, renderCache);
                gif.addFrame(exporter.context, { copy: true, delay: frameDelay });

                if (gifFpsClamped && frameIndex === 0) {
                    gifBtn.textContent = `Préparation GIF ${frameIndex + 1}/${totalFrames} (100fps max GIF)`;
                } else {
                    gifBtn.textContent = `Préparation GIF ${frameIndex + 1}/${totalFrames} (${effectiveGifFps}fps)`;
                }

                if ((frameIndex + 1) % Math.max(1, Math.floor(MAX_ANIMATION_FPS / framesPerSecond)) === 0) {
                    // Laisser souffler le thread principal de temps en temps seulement
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }

            gifBtn.textContent = 'Finalisation...';

            const gifBlob = await new Promise((resolve, reject) => {
                gif.on('finished', (blob) => {
                    if (!blob) {
                        reject(new Error('GIF generation failed'));
                        return;
                    }
                    resolve(blob);
                });
                gif.render();
            });

            const url = URL.createObjectURL(gifBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sinus-gradient-${Date.now()}.gif`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('GIF export error:', error);
            alert('Erreur pendant l’export GIF : ' + error.message);
        } finally {
            if (exporter) {
                exporter.dispose();
            }
            uniforms.time = savedTime;
            uniforms.resolution = savedResolution;
            gifBtn.disabled = false;
            gifBtn.textContent = 'Export GIF HQ';
        }
    }

    async function exportHighQualityVideo() {
        const videoBtn = document.getElementById('exportVideoBtn');
        if (!videoBtn) {
            return;
        }

        if (typeof MediaRecorder !== 'function') {
            alert('MediaRecorder n’est pas supporté par ce navigateur.');
            return;
        }

        const mimeType = VIDEO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
        if (!mimeType) {
            alert('Aucun format vidéo compatible (MP4/WebM) n’est disponible sur ce navigateur.');
            return;
        }

        const animationParams = getAnimationParameters({
            maxDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
            maxFrames: MAX_VIDEO_FRAMES
        });
        if (!animationParams || animationParams.error) {
            alert(animationParams ? animationParams.error : 'Paramètres vidéo invalides.');
            return;
        }

        const { durationSeconds, framesPerSecond, totalFrames } = animationParams;

        videoBtn.disabled = true;
        videoBtn.textContent = 'Préparation...';

        const savedTime = uniforms.time;
        const savedResolution = uniforms.resolution;

        let exporter;
        let recorder;
        let stream;
        try {
            const qualityFactor = 3.5;
            exporter = createHighQualityRenderer(qualityFactor);
            const renderCache = exporter.createRenderCache();

            const recordingCanvas = document.createElement('canvas');
            recordingCanvas.width = exporter.width;
            recordingCanvas.height = exporter.height;
            const recordingCtx = recordingCanvas.getContext('2d');

            stream = recordingCanvas.captureStream(framesPerSecond);
            const videoChunks = [];

            recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: Math.min(
                    25000000,
                    Math.max(6000000, exporter.width * exporter.height * framesPerSecond * 0.6)
                )
            });

            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size) {
                    videoChunks.push(event.data);
                }
            };

            const recorderStopped = new Promise((resolve, reject) => {
                recorder.onstop = resolve;
                recorder.onerror = (event) => reject(event.error || new Error('Erreur MediaRecorder'));
            });

            recorder.start();

            const track = stream.getVideoTracks()[0];
            const frameIntervalMs = 1000 / framesPerSecond;
            const startTime = savedTime;

            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                const frameTime = startTime + frameIndex / framesPerSecond;
                exporter.renderFrame(frameTime, renderCache);
                recordingCtx.drawImage(exporter.canvas, 0, 0);
                if (track && typeof track.requestFrame === 'function') {
                    track.requestFrame();
                }

                videoBtn.textContent = `Export Vidéo ${frameIndex + 1}/${totalFrames}`;

                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => {
                    setTimeout(resolve, Math.max(0, frameIntervalMs - 2));
                });
            }

            recorder.stop();
            await recorderStopped;

            const mimeForBlob = videoChunks.length > 0 ? videoChunks[0].type || mimeType : mimeType;
            const videoBlob = new Blob(videoChunks, { type: mimeForBlob });
            if (!videoBlob.size) {
                throw new Error('Le flux vidéo est vide.');
            }

            const url = URL.createObjectURL(videoBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sinus-gradient-${Date.now()}.${mimeForBlob.includes('mp4') ? 'mp4' : 'webm'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            videoBtn.disabled = false;
            videoBtn.textContent = 'Export Vidéo HQ';
        } catch (error) {
            console.error('Video export error:', error);
            alert('Erreur pendant l’export vidéo : ' + error.message);
            videoBtn.disabled = false;
            videoBtn.textContent = 'Export Vidéo HQ';
        } finally {
            if (recorder && recorder.state !== 'inactive') {
                recorder.stop();
            }
            if (stream) {
                stream.getTracks().forEach((track) => track.stop());
            }
            if (exporter) {
                exporter.dispose();
            }
            uniforms.time = savedTime;
            uniforms.resolution = savedResolution;
        }
    }

    const textInputsContainer = document.getElementById('textInputsContainer');
    const addTextInputBtn = document.getElementById('addTextInputBtn');

    function syncTextInputUI(focusIndex = null) {
        if (!textInputsContainer) {
            return;
        }

        const entries = Array.isArray(textData.entries) && textData.entries.length > 0
            ? [...textData.entries]
            : ['SINUS'];

        textInputsContainer.innerHTML = '';

        entries.forEach((value, index) => {
            const row = document.createElement('div');
            row.className = 'multi-text-row';
            row.dataset.index = index.toString();

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'line-text-input';
            input.placeholder = `Texte ${index + 1}`;
            input.value = value;
            input.dataset.index = index.toString();
            input.addEventListener('input', (event) => {
                textData.entries[index] = event.target.value;
                cachedTextOld = '';
                invalidateTextCache();
            });
            input.addEventListener('blur', (event) => {
                textData.entries[index] = event.target.value;
                cachedTextOld = '';
                invalidateTextCache();
            });

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'remove-text-btn';
            removeBtn.setAttribute('aria-label', 'Retirer cette variante');
            removeBtn.textContent = '×';
            removeBtn.disabled = entries.length <= 1;
            removeBtn.addEventListener('click', () => {
                if (textData.entries.length > 1) {
                    textData.entries.splice(index, 1);
                } else {
                    textData.entries[0] = '';
                }
                cachedTextOld = '';
                invalidateTextCache();
                syncTextInputUI(Math.min(index, Math.max(0, textData.entries.length - 1)));
            });

            row.appendChild(input);
            row.appendChild(removeBtn);
            textInputsContainer.appendChild(row);

            if (focusIndex !== null && focusIndex === index) {
                setTimeout(() => input.focus(), 0);
            }
        });

        if (addTextInputBtn) {
            addTextInputBtn.disabled = textData.entries.length >= MAX_TEXT_VARIANTS;
        }
    }

    if (addTextInputBtn) {
        addTextInputBtn.addEventListener('click', () => {
            if (textData.entries.length >= MAX_TEXT_VARIANTS) {
                return;
            }
            textData.entries.push('');
            cachedTextOld = '';
            invalidateTextCache();
            syncTextInputUI(textData.entries.length - 1);
        });
    }

    syncTextInputUI(0);

    // Event listeners pour les contrôles

    document.getElementById('fontFamily').addEventListener('change', (e) => {
        textData.fontFamily = e.target.value;
        // Invalider le cache quand la police change
        cachedTextOld = '';
        invalidateTextCache();
    });

    document.getElementById('numCurves').addEventListener('input', (e) => {
        uniforms.numCurves = parseInt(e.target.value);
        document.getElementById('numCurvesValue').textContent = e.target.value;
    });

    document.getElementById('amplitude').addEventListener('input', (e) => {
        uniforms.amplitude = parseFloat(e.target.value);
        document.getElementById('amplitudeValue').textContent = e.target.value;
    });

    document.getElementById('frequency').addEventListener('input', (e) => {
        uniforms.frequency = parseFloat(e.target.value);
        document.getElementById('frequencyValue').textContent = e.target.value;
    });

    document.getElementById('speed').addEventListener('input', (e) => {
        uniforms.speed = parseFloat(e.target.value);
        document.getElementById('speedValue').textContent = e.target.value;
    });

    document.getElementById('spacing').addEventListener('input', (e) => {
        uniforms.spacing = parseFloat(e.target.value);
        document.getElementById('spacingValue').textContent = e.target.value;
    });

    document.getElementById('hue').addEventListener('input', (e) => {
        uniforms.hue = parseFloat(e.target.value);
        document.getElementById('hueValue').textContent = e.target.value;
    });

    document.getElementById('motionBlur').addEventListener('input', (e) => {
        uniforms.motionBlur = parseFloat(e.target.value);
        document.getElementById('motionBlurValue').textContent = e.target.value;
        
        // Afficher/masquer les sélecteurs de couleur selon l'état du motion blur
        const textColorGroup = document.getElementById('textColorGroup');
        const backgroundColorGroup = document.getElementById('backgroundColorGroup');
        
        if (uniforms.motionBlur > 0.01) {
            textColorGroup.classList.add('hidden');
            backgroundColorGroup.classList.add('hidden');
        } else {
            textColorGroup.classList.remove('hidden');
            backgroundColorGroup.classList.remove('hidden');
        }
    });

    document.getElementById('phase').addEventListener('input', (e) => {
        uniforms.phase = parseFloat(e.target.value);
        document.getElementById('phaseValue').textContent = e.target.value;
    });

    document.getElementById('waveType').addEventListener('change', (e) => {
        const waveTypeValue = parseInt(e.target.value);
        uniforms.waveType = waveTypeValue;
    });

    document.getElementById('rotation').addEventListener('input', (e) => {
        uniforms.rotation = parseFloat(e.target.value);
        document.getElementById('rotationValue').textContent = e.target.value;
    });

    document.getElementById('verticalOffset').addEventListener('input', (e) => {
        uniforms.verticalOffset = parseFloat(e.target.value);
        document.getElementById('verticalOffsetValue').textContent = e.target.value;
    });

    document.getElementById('timeStagger').addEventListener('input', (e) => {
        uniforms.timeStagger = parseFloat(e.target.value);
        document.getElementById('timeStaggerValue').textContent = e.target.value;
    });

    document.getElementById('textSize').addEventListener('input', (e) => {
        textData.size = parseInt(e.target.value);
        document.getElementById('textSizeValue').textContent = e.target.value;
        // Invalider le cache quand la taille change
        cachedTextSizeOld = 0;
        invalidateTextCache();
    });

    document.getElementById('textColor').addEventListener('input', (e) => {
        uniforms.textColor = hexToRgb(e.target.value);
        const hexInput = document.getElementById('textColorHex');
        if (hexInput) hexInput.value = e.target.value.toUpperCase();
    });

    document.getElementById('backgroundColor').addEventListener('input', (e) => {
        uniforms.backgroundColor = hexToRgb(e.target.value);
        const hexInput = document.getElementById('backgroundColorHex');
        if (hexInput) hexInput.value = e.target.value.toUpperCase();
    });

    // Chargement d'image
    const imageLoader = document.getElementById('imageLoader');
    if (imageLoader) {
        imageLoader.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const img = new Image();
            img.onload = () => {
                loadedImage = img;
                imageMode = true;
                // Si l'utilisateur veut la couleur, garder u_preserveImageColor=1, sinon 0
                const toggle = document.getElementById('imageColorToggle');
                if (toggle) {
                    uniforms.preserveImageColor = toggle.checked ? 1.0 : 0.0;
                }
                // Forcer un redraw immédiat
                invalidateTextCache();
            };
            img.onerror = () => {
                console.warn('Échec du chargement de l\'image');
            };
            img.src = URL.createObjectURL(file);
        });
    }

    // Toggle couleur image
    const imageColorToggle = document.getElementById('imageColorToggle');
    if (imageColorToggle) {
        imageColorToggle.addEventListener('change', (e) => {
            // Actif seulement pertinent en mode image
            uniforms.preserveImageColor = (imageMode && e.target.checked) ? 1.0 : 0.0;
        });
    }

    document.getElementById('heatMapToggle').addEventListener('change', (e) => {
        uniforms.heatMapEnabled = e.target.checked ? 1.0 : 0.0;
    });

    // Event listener pour le grain
    document.getElementById('grain').addEventListener('input', (e) => {
        uniforms.grain = parseFloat(e.target.value);
        document.getElementById('grainValue').textContent = e.target.value;
    });


    // Initialiser l'état des sélecteurs de couleur au démarrage
    const textColorGroup = document.getElementById('textColorGroup');
    const backgroundColorGroup = document.getElementById('backgroundColorGroup');
    const textColorHexInput = document.getElementById('textColorHex');
    const backgroundColorHexInput = document.getElementById('backgroundColorHex');
    
    // Au démarrage, motionBlur = 0, donc afficher les sélecteurs
    textColorGroup.classList.remove('hidden');
    backgroundColorGroup.classList.remove('hidden');

    // Synchroniser les champs HEX initiaux avec les pickers
    if (textColorHexInput) textColorHexInput.value = document.getElementById('textColor').value.toUpperCase();
    if (backgroundColorHexInput) backgroundColorHexInput.value = document.getElementById('backgroundColor').value.toUpperCase();

    // Helpers validation HEX (#RRGGBB)
    function normalizeHex(value) {
        if (!value) return null;
        let v = value.trim();
        if (v[0] !== '#') v = '#' + v;
        const m = /^#([0-9a-fA-F]{6})$/.exec(v);
        return m ? ('#' + m[1].toUpperCase()) : null;
    }

    // Entrée HEX -> uniforms et picker
    if (textColorHexInput) {
        textColorHexInput.addEventListener('change', (e) => {
            const norm = normalizeHex(e.target.value);
            if (norm) {
                document.getElementById('textColor').value = norm;
                e.target.value = norm;
                uniforms.textColor = hexToRgb(norm);
            } else {
                // Revenir à la valeur valide actuelle
                e.target.value = document.getElementById('textColor').value.toUpperCase();
            }
        });
    }

    if (backgroundColorHexInput) {
        backgroundColorHexInput.addEventListener('change', (e) => {
            const norm = normalizeHex(e.target.value);
            if (norm) {
                document.getElementById('backgroundColor').value = norm;
                e.target.value = norm;
                uniforms.backgroundColor = hexToRgb(norm);
            } else {
                e.target.value = document.getElementById('backgroundColor').value.toUpperCase();
            }
        });
    }


    // Fonction pour réinitialiser tous les paramètres
    function resetAll() {
        // Réinitialiser les uniforms
        uniforms.numCurves = 5;
        uniforms.amplitude = 50;
        uniforms.frequency = 2;
        uniforms.speed = 2.0;
        uniforms.spacing = 0.8;
        uniforms.hue = 0.0;
        uniforms.motionBlur = 0.0;
        uniforms.phase = 0.0;
        uniforms.waveType = 0.0;
        uniforms.rotation = 0.0;
        uniforms.verticalOffset = 0.0;
        uniforms.timeStagger = 0.0;
        uniforms.backgroundColor = [0.0, 0.0, 0.0];
        uniforms.heatMapEnabled = 1.0;
        uniforms.grain = 0.0;
        uniforms.textColor = [1.0, 1.0, 1.0];
        uniforms.preserveImageColor = 0.0;
        imageMode = false;
        loadedImage = null;
        
        // Réinitialiser le texte
        textData.entries = ['SINUS'];
        textData.size = 96;
        textData.fontFamily = 'Arial';
        
        // Réinitialiser les sliders HTML
        document.getElementById('numCurves').value = 5;
        document.getElementById('numCurvesValue').textContent = '5';
        
        document.getElementById('amplitude').value = 50;
        document.getElementById('amplitudeValue').textContent = '50';
        
        document.getElementById('frequency').value = 2;
        document.getElementById('frequencyValue').textContent = '2';
        
        document.getElementById('speed').value = 2.0;
        document.getElementById('speedValue').textContent = '2.0';
        
        document.getElementById('spacing').value = 0.8;
        document.getElementById('spacingValue').textContent = '0.8';
        
        document.getElementById('hue').value = 0;
        document.getElementById('hueValue').textContent = '0';
        
        document.getElementById('motionBlur').value = 0;
        document.getElementById('motionBlurValue').textContent = '0';
        
        document.getElementById('phase').value = 0;
        document.getElementById('phaseValue').textContent = '0';
        
        document.getElementById('waveType').value = '0';
        
        document.getElementById('rotation').value = 0;
        document.getElementById('rotationValue').textContent = '0';
        
        document.getElementById('verticalOffset').value = 0;
        document.getElementById('verticalOffsetValue').textContent = '0';
        
        document.getElementById('timeStagger').value = 0;
        document.getElementById('timeStaggerValue').textContent = '0';
        
        document.getElementById('textSize').value = 96;
        document.getElementById('textSizeValue').textContent = '96';
        
        syncTextInputUI(0);
        document.getElementById('fontFamily').value = 'Arial';
        document.getElementById('textColor').value = '#ffffff';
        document.getElementById('backgroundColor').value = '#000000';
        const tHex = document.getElementById('textColorHex');
        const bHex = document.getElementById('backgroundColorHex');
        if (tHex) tHex.value = '#FFFFFF';
        if (bHex) bHex.value = '#000000';
        const imageLoaderInput = document.getElementById('imageLoader');
        if (imageLoaderInput) imageLoaderInput.value = '';
        const imageColorToggleEl = document.getElementById('imageColorToggle');
        if (imageColorToggleEl) imageColorToggleEl.checked = true;
        document.getElementById('heatMapToggle').checked = true;
        document.getElementById('grain').value = 0;
        document.getElementById('grainValue').textContent = '0';
        
        // Invalider le cache
        cachedTextOld = '';
        cachedTextSizeOld = 0;
        invalidateTextCache();
    }

    document.getElementById('resetBtn').addEventListener('click', resetAll);

    document.getElementById('exportBtn').addEventListener('click', exportHighQuality);
    const exportGifBtn = document.getElementById('exportGifBtn');
    if (exportGifBtn) {
        exportGifBtn.addEventListener('click', exportHighQualityGIF);
    }
    const exportVideoBtn = document.getElementById('exportVideoBtn');
    if (exportVideoBtn) {
        exportVideoBtn.addEventListener('click', exportHighQualityVideo);
    }

    // Démarrer l'animation
    renderCombined();
}

