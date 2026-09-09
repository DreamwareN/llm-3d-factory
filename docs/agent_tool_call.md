# Three.js 建模 Agent 专用工具集技术规范文档 (RFC-002)

本规范定义了一套供大语言模型（LLM）驱动的 Three.js 程序化建模工具集（14 个核心 Tools）。文档包含全局约定、类型系统、工具接口定义（JSON Schema 规范）及统一的运行时反馈协议。

---

## 一、 全局约定与数据结构

### 1. 空间与物理约定

* **坐标系**：Three.js 原生右手坐标系（$Y$ 轴朝上，$X$ 轴向右，$Z$ 轴朝前）。
* **单位系统**：长度单位统一为米（meters），角度输入统一为弧度（radians）。
* **轴对齐包围盒（AABB）**：所有构建与变换类工具，在执行成功后必须将最新的 AABB 写入执行结果回包，以切断 LLM 对三维绝对坐标的心算依赖。

### 2. 基础数据类型定义 (TypeScript Interfaces)

```typescript
// 三维向量 [x, y, z]
type Vec3 = [number, number, number];

// 轴对齐包围盒数据规范
interface BoundingBox {
  min: Vec3;       // [minX, minY, minZ]
  max: Vec3;       // [maxX, maxY, maxZ]
  size: Vec3;      // [width(X), height(Y), depth(Z)]
  center: Vec3;    // [centerX, centerY, centerZ]
}

// 基础 PBR 材质参数集
interface PBRMaterialConfig {
  color?: string;           // 十六进制颜色代码，如 "#FFFFFF"
  roughness?: number;       // 粗糙度 [0.0 - 1.0]
  metalness?: number;       // 金属度 [0.0 - 1.0]
  transmission?: number;    // 透光率/玻璃感 [0.0 - 1.0]
  opacity?: number;         // 不透明度 [0.0 - 1.0]
  wireframe?: boolean;      // 是否开启线框
}

// 标准工具返回载荷
interface ToolExecutionResult {
  success: boolean;
  object_id?: string;
  affected_ids?: string[];
  aabb?: BoundingBox;
  message?: string;
  error?: string;
}

```

---

## 二、 几何与实体构建工具集 (Geometry & Mesh)

### 1. `create_primitive`

* **功能描述**：在指定坐标直接实例化一个标准 3D 基础几何体，并赋予初始材质。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "create_primitive",
  "description": "创建标准几何体（立方体、球体、圆柱、圆锥、圆环、平面），初始化其尺寸、材质与坐标",
  "parameters": {
    "type": "object",
    "required": ["primitive_type", "dimensions"],
    "properties": {
      "primitive_type": {
        "type": "string",
        "enum": ["box", "sphere", "cylinder", "cone", "torus", "plane"]
      },
      "dimensions": {
        "type": "object",
        "description": "尺寸参数。box: {width, height, depth}; sphere: {radius}; cylinder: {radiusTop, radiusBottom, height}; torus: {radius, tube}",
        "properties": {
          "width": { "type": "number" },
          "height": { "type": "number" },
          "depth": { "type": "number" },
          "radius": { "type": "number" },
          "radiusTop": { "type": "number" },
          "radiusBottom": { "type": "number" },
          "tube": { "type": "number" }
        }
      },
      "position": {
        "type": "array",
        "items": { "type": "number" },
        "description": "初始世界坐标 [x, y, z]，默认为 [0, 0, 0]"
      },
      "material": {
        "type": "object",
        "description": "初始 PBR 材质参数",
        "properties": {
          "color": { "type": "string" },
          "roughness": { "type": "number" },
          "metalness": { "type": "number" }
        }
      }
    }
  }
}

```

### 2. `create_extrude_mesh`

* **功能描述**：基于 2D 平面闭合点集（二维轮廓）沿法线拉伸生成带倒角/平滑边缘的 3D 构件。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "create_extrude_mesh",
  "description": "通过二维闭合点集进行线性拉伸生成三维异形构件，适用于异形截面构件、踢脚线、弧形板等",
  "parameters": {
    "type": "object",
    "required": ["contour_points", "depth"],
    "properties": {
      "contour_points": {
        "type": "array",
        "description": "XY 平面上的 2D 轮廓点序列，自动闭合",
        "items": {
          "type": "array",
          "items": { "type": "number" }
        }
      },
      "depth": {
        "type": "number",
        "description": "沿 Z 轴拉伸的深度"
      },
      "bevel_enabled": {
        "type": "boolean",
        "default": true,
        "description": "是否开启斜角倒角"
      },
      "bevel_thickness": {
        "type": "number",
        "default": 0.01,
        "description": "倒角深度（米）"
      },
      "position": {
        "type": "array",
        "items": { "type": "number" }
      }
    }
  }
}

```

### 3. `boolean_mesh`

* **功能描述**：调用 CSG 算法对两个已有网格进行布尔运算（差集、并集、交集），用于开槽、打孔与复杂嵌合。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "boolean_mesh",
  "description": "对两个网格执行 CSG 构造实体几何运算（subtract 挖孔/开槽，union 融合成整体，intersect 取公共部分）",
  "parameters": {
    "type": "object",
    "required": ["operation", "target_id", "operand_id"],
    "properties": {
      "operation": {
        "type": "string",
        "enum": ["subtract", "union", "intersect"]
      },
      "target_id": {
        "type": "string",
        "description": "被操作的主体对象 ID"
      },
      "operand_id": {
        "type": "string",
        "description": "运算源对象 ID（如充当开孔钻头的网格）"
      },
      "keep_operand": {
        "type": "boolean",
        "default": false,
        "description": "运算后是否保留 operand 对象，默认为 false（自动销毁）"
      }
    }
  }
}

```

### 4. `duplicate_object`

* **功能描述**：快速克隆指定网格或 Group，支持线性或环形阵列变换。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "duplicate_object",
  "description": "复制对象并按指定步长生成线性或环形阵列，用于柱廊、楼梯、椅列等重复性结构",
  "parameters": {
    "type": "object",
    "required": ["source_id", "count"],
    "properties": {
      "source_id": { "type": "string", "description": "源对象 ID" },
      "count": { "type": "integer", "minimum": 1, "description": "克隆副本数量" },
      "array_type": {
        "type": "string",
        "enum": ["linear", "radial"],
        "default": "linear"
      },
      "linear_offset": {
        "type": "array",
        "items": { "type": "number" },
        "description": "线性阵列时每个副本之间的步进位移 [dx, dy, dz]"
      },
      "radial_center": {
        "type": "array",
        "items": { "type": "number" },
        "description": "环形阵列的旋转中心坐标"
      },
      "radial_axis": {
        "type": "string",
        "enum": ["X", "Y", "Z"],
        "default": "Y",
        "description": "环形阵列的旋转轴"
      },
      "total_angle": {
        "type": "number",
        "description": "环形阵列跨越的总弧度（如 2*PI 为 360 度封闭环）"
      }
    }
  }
}

```

---

## 三、 空间装配与层级系统 (Spatial Assembly & Hierarchy)

### 5. `transform_object`

* **功能描述**：统一对目标对象进行绝对或相对平移、旋转与缩放。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "transform_object",
  "description": "调整对象的空间变换矩阵（平移、旋转、缩放）",
  "parameters": {
    "type": "object",
    "required": ["object_id"],
    "properties": {
      "object_id": { "type": "string" },
      "position": {
        "type": "array",
        "items": { "type": "number" },
        "description": "[x, y, z] 目标坐标"
      },
      "rotation": {
        "type": "array",
        "items": { "type": "number" },
        "description": "[rx, ry, rz] 欧拉角（弧度）"
      },
      "scale": {
        "type": "array",
        "items": { "type": "number" },
        "description": "[sx, sy, sz] 缩放因子"
      },
      "space": {
        "type": "string",
        "enum": ["world", "local"],
        "default": "world",
        "description": "变换所处参照系"
      },
      "relative": {
        "type": "boolean",
        "default": false,
        "description": "为 true 时表示在现有变换值上累加（增量模式）"
      }
    }
  }
}

```

### 6. `align_object`

* **功能描述**：通过计算源对象与目标对象（或地平面）的 AABB 极值，自动施加对齐位移，杜绝悬空或穿模。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "align_object",
  "description": "语义化对齐工具。利用 AABB 包围盒实现源对象与目标对象在指定轴上的吸附、居中或靠齐",
  "parameters": {
    "type": "object",
    "required": ["source_id", "target_id", "axis", "alignment"],
    "properties": {
      "source_id": { "type": "string", "description": "被移动对齐的对象 ID" },
      "target_id": {
        "type": "string",
        "description": "对齐基准对象 ID。特例值 'ground' 代表地面基准面 (Y=0)"
      },
      "axis": {
        "type": "string",
        "enum": ["X", "Y", "Z"],
        "description": "执行对齐的坐标轴"
      },
      "alignment": {
        "type": "string",
        "enum": ["min_to_max", "max_to_min", "center_to_center", "min_to_min", "max_to_max"],
        "description": "对齐模式。如在 Y 轴上 min_to_max 表示将 source 底部稳固贴合在 target 顶部（堆叠）"
      },
      "offset": {
        "type": "number",
        "default": 0,
        "description": "沿对齐轴施加的间隙微调量（可为负值）"
      }
    }
  }
}

```

### 7. `group_objects`

* **功能描述**：将离散物体挂载至统一的 `THREE.Group` 节点下，并支持重定位中心轴（Pivot）。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "group_objects",
  "description": "将多个对象编组至同一个层级容器，支持设置父级的基准锚点（Pivot）",
  "parameters": {
    "type": "object",
    "required": ["object_ids"],
    "properties": {
      "object_ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "待归组的子对象 ID 列表"
      },
      "group_name": { "type": "string", "description": "编组语义名（如 table_assembly）" },
      "pivot_position": {
        "type": "string",
        "enum": ["center", "bottom_center", "world_origin"],
        "default": "bottom_center",
        "description": "编组的局部坐标系原点（Pivot）定位策略"
      }
    }
  }
}

```

### 8. `delete_object`

* **功能描述**：从场景中删除指定对象或整个 Group（连同其所有子对象），用于替换或清理错误的部件。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "delete_object",
  "description": "删除一个对象或编组（Group 会连同子对象一起删除）",
  "parameters": {
    "type": "object",
    "required": ["object_id"],
    "properties": {
      "object_id": { "type": "string", "description": "待删除的对象 ID（可为 Group）" }
    }
  }
}

```

---

## 四、 材质与环境外观 (Appearance & Atmosphere)

### 9. `modify_material`

* **功能描述**：更新或切换对象的物理材质属性。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "modify_material",
  "description": "修改一个或多个对象的 PBR 物理材质属性（颜色、粗糙度、金属感、透光度等）",
  "parameters": {
    "type": "object",
    "required": ["object_id", "properties"],
    "properties": {
      "object_id": { "type": "string" },
      "properties": {
        "type": "object",
        "properties": {
          "color": { "type": "string" },
          "roughness": { "type": "number", "minimum": 0, "maximum": 1 },
          "metalness": { "type": "number", "minimum": 0, "maximum": 1 },
          "transmission": { "type": "number", "minimum": 0, "maximum": 1 },
          "opacity": { "type": "number", "minimum": 0, "maximum": 1 },
          "wireframe": { "type": "boolean" }
        }
      }
    }
  }
}

```

### 10. `setup_lighting`

* **功能描述**：统一设置场景的照明方案、主光源方向与阴影状态。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "setup_lighting",
  "description": "配置场景照明方案，提供标准照明预设及自定义光源微调",
  "parameters": {
    "type": "object",
    "properties": {
      "preset": {
        "type": "string",
        "enum": ["studio_soft", "sunlight_harsh", "warm_interior", "cold_minimal"],
        "description": "标准照明环境预设"
      },
      "ambient_intensity": {
        "type": "number",
        "description": "环境光基础强度 [0.0 - 2.0]"
      },
      "main_light_position": {
        "type": "array",
        "items": { "type": "number" },
        "description": "主定向光坐标 [x, y, z]"
      },
      "cast_shadows": {
        "type": "boolean",
        "default": true,
        "description": "是否开启全场景阴影投射"
      }
    }
  }
}

```

---

## 五、 状态自检与兜底逃生舱 (Inspection & Fallback)

### 11. `inspect_scene`

* **功能描述**：返回场景树的拓扑结构、所有物体的世界坐标及精确包围盒，是 Agent 自主推理空间布局的核心工具。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "inspect_scene",
  "description": "获取当前场景完整的结构树、对象清单、世界坐标及 AABB 包围盒数据",
  "parameters": {
    "type": "object",
    "properties": {
      "target_id": {
        "type": "string",
        "description": "若指定则仅巡检该对象及其子节点；留空则巡检整场"
      },
      "include_bounding_boxes": {
        "type": "boolean",
        "default": true,
        "description": "是否计算并返回精确尺寸数据"
      }
    }
  }
}

```

### 12. `capture_viewport`

* **功能描述**：驱动渲染相机以特定视角对画布进行离屏渲染，输出图像数据给多模态大模型进行自检。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "capture_viewport",
  "description": "以指定相机视角截取当前场景渲染图，用于视觉自检、透视评估与比例核查",
  "parameters": {
    "type": "object",
    "required": ["camera_view"],
    "properties": {
      "camera_view": {
        "type": "string",
        "enum": ["isometric", "front", "top", "side", "perspective_detail"],
        "description": "视角选择：等轴测视图、正视图、顶视图、侧视图或特写视角"
      },
      "focus_target_id": {
        "type": "string",
        "description": "相机观察聚焦点对象 ID；留空则聚焦全场景中心"
      }
    }
  }
}

```

### 13. `capture_multiview`

* **功能描述**：一次性从多个相机视角（默认正面、侧面、45° 鸟瞰、背面）渲染当前场景，把多张图作为同一条工具结果返回给多模态大模型，用于在修改既有模型前建立整体认知（“多视角图看外观 + 场景树 JSON 读结构”）。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "capture_multiview",
  "description": "一次渲染多个相机视角并返回全部图像，用于整体外观自检",
  "parameters": {
    "type": "object",
    "properties": {
      "views": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["front", "back", "left", "right", "side", "top", "bottom", "isometric", "perspective", "perspective_detail"]
        },
        "maxItems": 8,
        "description": "要渲染的视角列表，默认 [\"front\", \"side\", \"isometric\", \"back\"]"
      },
      "focus_target_id": {
        "type": "string",
        "description": "每个视角都围绕该对象取景；留空则聚焦全场景"
      }
    }
  }
}

```

### 14. `eval_code_fallback`

* **功能描述**：代码沙箱执行器。当高层工具无法满足极端参数化几何（如弹簧、非均匀网格扭曲、数学拓扑曲面）时，执行原生 JavaScript/Three.js 片段。
* **参数定义 (JSON Schema)**：

```json
{
  "name": "eval_code_fallback",
  "description": "执行原生 Three.js 脚本片段（沙箱环境）。仅在专用工具无法表达特殊数学几何体或顶点动画时作为最后手段使用",
  "parameters": {
    "type": "object",
    "required": ["code"],
    "properties": {
      "code": {
        "type": "string",
        "description": "JavaScript 执行脚本，暴露变量包含 { scene, THREE, targetGroup }"
      },
      "fallback_intent": {
        "type": "string",
        "description": "简要阐明为何专用工具无法达成该需求（用于日志监控与审计）"
      }
    }
  }
}

```

---

## 六、 运行时返回协议规范

为了保证 Agent 能进行多步确定性推理，所有工具调用执行完毕后，执行层必须返回严格标准化的 JSON 结果：

```json
{
  "success": true,
  "object_id": "table_leg_01",
  "aabb": {
    "min": [-0.05, 0.0, -0.05],
    "max": [0.05, 0.72, 0.05],
    "size": [0.1, 0.72, 0.1],
    "center": [0.0, 0.36, 0.0]
  },
  "message": "Primitive 'cylinder' created successfully. Placed at world position [0, 0.36, 0]."
}

```

### 错误处理协议

若遇到参数冲突或布尔运算失败（例如 CSG 发生自相交或空网格），运行时必须返回结构化失败信息并包含修复指引：

```json
{
  "success": false,
  "error_code": "CSG_NON_MANIFOLD_GEOMETRY",
  "error": "Boolean subtraction failed: Operand mesh 'cutter_box' does not intersect with 'main_panel'.",
  "suggestion": "Inspect bounding boxes using 'inspect_scene' and re-align objects using 'align_object' before retrying."
}

```