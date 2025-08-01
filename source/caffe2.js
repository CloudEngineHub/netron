
const caffe2 = {};

caffe2.ModelFactory = class {

    async match(context) {
        const identifier = context.identifier.toLowerCase();
        const extension = identifier.lastIndexOf('.') > 0 ? identifier.split('.').pop().toLowerCase() : '';
        switch (extension) {
            case 'pbtxt':
            case 'prototxt': {
                const tags = await context.tags('pbtxt');
                if (tags.has('op') && !tags.has('op.attr') && !tags.has('op.graph_op_name') && !tags.has('op.endpoint')) {
                    return context.set('caffe2.pbtxt');
                }
                break;
            }
            case 'pb': {
                const tags = await context.tags('pb');
                if (tags.size > 0 &&
                    Array.from(tags.keys()).every((tag) => tag <= 9) &&
                    Array.from(tags.values()).every((type) => type <= 4)) {
                    if (tags.size === 1 && tags.get(2) === 2 && identifier.endsWith('saved_model.pb')) {
                        return null;
                    }
                    const schema = [[1,2],[2,2],[3,2],[4,0],[5,2],[6,2],[7,2],[8,2],[9,2]];
                    if (schema.every(([key, value]) => !tags.has(key) || tags.get(key) === value)) {
                        const stream = context.stream;
                        if (stream.length > 3) {
                            const buffer = stream.peek(Math.min(stream.length, 67));
                            const [signature, size] = buffer;
                            switch (signature) {
                                case 0x0A:
                                    if (size < 64 &&
                                        buffer.length > 2 + size + 1 &&
                                        buffer.slice(2, 2 + size).every((c) => c >= 32 && c <= 127) &&
                                        buffer[2 + size] === 0x12) {
                                        return context.set('caffe2.pb');
                                    }
                                    break;
                                case 0x12:
                                    return context.set('caffe2.pb');
                                default:
                                    break;
                            }
                        }
                    }
                }
                break;
            }
            default: {
                break;
            }
        }
        return null;
    }

    async open(context) {
        caffe2.proto = await context.require('./caffe2-proto');
        caffe2.proto = caffe2.proto.caffe2;
        const metadata = await context.metadata('caffe2-metadata.json');
        const identifier = context.identifier;
        const parts = identifier.split('.');
        const extension = parts.pop().toLowerCase();
        const base = parts.join('.');
        let predict = null;
        let init = null;
        switch (context.type) {
            case 'caffe2.pbtxt': {
                if (base.toLowerCase().endsWith('init_net') || base.toLowerCase().startsWith('init_net')) {
                    init = context;
                    try {
                        const name = identifier.replace('init_net', 'predict_net');
                        predict = await context.fetch(name);
                        predict.set(context.type);
                    } catch {
                        // continue regardless of error
                    }
                } else if (base.toLowerCase().endsWith('predict_net') || base.toLowerCase().startsWith('predict_net')) {
                    predict = context;
                    const name = identifier.replace('predict_net', 'init_net');
                    try {
                        init = await context.fetch(name.replace(/\.pbtxt/, '.pb'));
                        init.set('caffe2.pb');
                    } catch {
                        try {
                            init = await context.fetch(name);
                            init.set('caffe2.pbtxt');
                        } catch {
                            // continue regardless of error
                        }
                    }
                } else {
                    predict = context;
                    try {
                        init = await context.fetch(`${base}_init.pb`);
                        init.set('caffe2.pb');
                    } catch {
                        // continue regardless of error
                    }
                }
                break;
            }
            case 'caffe2.pb': {
                if (base.toLowerCase().endsWith('init_net')) {
                    init = context;
                    const extensions = new Set([extension, 'pb', 'pbtxt']);
                    for (const extension of extensions) {
                        try {
                            const name = `${base.replace(/init_net$/, '')}predict_net.${extension}`;
                            /* eslint-disable no-await-in-loop */
                            predict = await context.fetch(name);
                            /* eslint-enable no-await-in-loop */
                            predict.set(`caffe2.${extension}`);
                            break;
                        } catch {
                            // continue regardless of error
                        }
                    }
                } else if (base.toLowerCase().endsWith('_init')) {
                    try {
                        const name = `${base.replace(/_init$/, '')}.${extension}`;
                        predict = await context.fetch(name);
                        predict.set(context.type);
                    } catch {
                        // continue regardless of error
                    }
                } else if (base.toLowerCase().endsWith('predict_net') || base.toLowerCase().startsWith('predict_net')) {
                    predict = context;
                    try {
                        const name = identifier.replace('predict_net', 'init_net');
                        init = await context.fetch(name);
                        init.set(context.type);
                    } catch {
                        // continue regardless of error
                    }
                } else {
                    predict = context;
                    try {
                        const file = `${base}_init.${extension}`;
                        init = await context.fetch(file, null);
                        init.set(context.type);
                    } catch {
                        // continue regardless of error
                    }
                }
                break;
            }
            default: {
                throw new caffe2.Error(`Unsupported Caffe2 format '${context.type}'.`);
            }
        }
        if (!predict && !init) {
            throw new caffe2.Error(`Caffe2 model does not contain predict or init data.`);
        }
        const open = async (context) => {
            if (context) {
                switch (context.type) {
                    case 'caffe2.pb':
                        try {
                            const reader = await context.read('protobuf.binary');
                            return caffe2.proto.NetDef.decode(reader);
                        } catch (error) {
                            const message = error && error.message ? error.message : error.toString();
                            throw new caffe2.Error(`File format is not caffe2.NetDef (${message.replace(/\.$/, '')}).`);
                        }
                    case 'caffe2.pbtxt':
                        try {
                            const reader = await context.read('protobuf.text');
                            reader.field = function(tag, message) {
                                if (message instanceof caffe2.proto.DeviceOption) {
                                    message[tag] = this.read();
                                    return;
                                }
                                throw new Error(`Unknown field '${tag}' ${this.location()}`);
                            };
                            return caffe2.proto.NetDef.decodeText(reader);
                        } catch (error) {
                            const message = error && error.message ? error.message : error.toString();
                            throw new caffe2.Error(`File format is not caffe2.NetDef (${message.replace(/\.$/, '')}).`);
                        }
                    default:
                        throw new caffe2.Error(`Unsupported Caffe2 predict format '${context.type}'.`);
                }
            }
            return null;
        };
        const predict_net = await open(predict);
        const init_net = await open(init);
        return new caffe2.Model(metadata, predict_net, init_net);
    }
};

caffe2.Model = class {

    constructor(metadata, predict_net, init_net) {
        const net = predict_net || init_net;
        this.format = 'Caffe2';
        this.domain = net.domain || null;
        this.modules = [new caffe2.Graph(metadata, predict_net, init_net)];
    }
};

caffe2.Graph = class {

    constructor(metadata, predict_net, init_net) {
        const net = predict_net || init_net;
        init_net = predict_net ? init_net : null;
        this.name = net.name || '';
        this.nodes = [];
        this.description = net.type;
        const initializers = new Set();
        const tensors = new Map();
        for (const name of net.external_input) {
            tensors.set(name, new caffe2.Tensor(name, {}));
        }
        if (init_net) {
            const dataTypes = new Map([
                ['GivenTensorFill', 'float32'],
                ['GivenTensorDoubleFill', 'float64'],
                ['GivenTensorBoolFill', 'boolean'],
                ['GivenTensorByteStringToUInt8Fill', 'uint8'],
                ['GivenTensorInt16Fill', 'int16'],
                ['GivenTensorSInt16Fill', 'int16'],
                ['GivenTensorIntFill', 'int32'],
                ['GivenTensorInt64Fill', 'int64'],
                ['GivenTensorStringFill', 'string'],
                ['Int8GivenIntTensorFill', 'int32'],
                ['Int8GivenTensorFill', 'int8'],
                ['XavierFill', null],
                ['ConstantFill', null]
            ]);
            for (const op of init_net.op) {
                if (op.output && op.output.length === 1) {
                    const [name] = op.output;
                    const tensor = {};
                    for (const arg of op.arg) {
                        tensor[arg.name] = arg;
                    }
                    if (!dataTypes.has(op.type)) {
                        throw new caffe2.Error(`Unsupported init op '${op.type}'.`);
                    }
                    tensor.dataType = dataTypes.get(op.type);
                    if (tensor.values && tensor.values.floats && (tensor.values.floats.length !== 1 || tensor.values.floats[0] !== 0)) {
                        initializers.add(name);
                    }
                    tensors.set(name, new caffe2.Tensor(name, tensor));
                }
            }
        }
        const scope = {};
        for (let i = 0; i < net.op.length; i++) {
            const op = net.op[i];
            op.input = op.input.map((input) => scope[input] ? scope[input] : input);
            op.output = op.output.map((output) => {
                if (scope[output]) {
                    const next = `${output}\n${i}`; // custom argument id
                    scope[output] = next;
                    return next;
                }
                scope[output] = output;
                return output;
            });
        }
        const values = new Map();
        values.map = (name, type, tensor) => {
            if (!values.has(name)) {
                values.set(name, new caffe2.Value(name, type || null, tensor || null));
            } else if (type || tensor) {
                throw new caffe2.Value(`Duplicate value '${name}'.`);
            }
            return values.get(name);
        };
        for (const op of net.op) {
            let index = 0;
            for (const name of op.input) {
                if (index > 0 && tensors.has(name)) {
                    if (!values.has(name)) {
                        values.set(name, new caffe2.Value(name, null, tensors.get(name)));
                    }
                    initializers.add(name);
                }
                index++;
            }
        }
        for (const op of net.op) {
            for (const name of op.output) {
                if (tensors.has(name)) {
                    initializers.add(name);
                }
            }
        }
        let lastNode = null;
        let lastOutput = null;
        for (const op of net.op) {
            const node = new caffe2.Node(metadata, op, values);
            if (op.input.length === 1 &&
                op.output.length >= 1 &&
                op.input[0].split('\n').shift() === op.output[0].split('\n').shift() &&
                lastNode &&
                lastOutput === op.input[0].split('\n').shift()) {
                lastNode.chain.push(node);
            } else {
                this.nodes.push(node);
                lastNode = null;
                lastOutput = null;
                if (op.output.length === 1) {
                    lastNode = node;
                    lastOutput = op.output[0].split('\n').shift();
                }
            }
        }
        this.inputs = [];
        for (const input of net.external_input) {
            if (net.external_input.length > 1 && initializers.has(input)) {
                continue;
            }
            const argument = new caffe2.Argument(input, [values.map(input)]);
            this.inputs.push(argument);
        }
        this.outputs = [];
        for (const output of net.external_output) {
            const argument = new caffe2.Argument(output, [values.map(output)]);
            this.outputs.push(argument);
        }
    }
};

caffe2.Argument = class {

    constructor(name, value, type, visible) {
        this.name = name;
        this.value = value;
        this.type = type || null;
        this.visible = visible !== false;
    }
};

caffe2.Value = class {

    constructor(name, type, initializer) {
        if (typeof name !== 'string') {
            throw new caffe2.Error(`Invalid value identifier '${JSON.stringify(name)}'.`);
        }
        this.name = name;
        this.type = !type && initializer ? initializer.type : type;
        this.quantization = initializer && initializer.quantization ? initializer.quantization : null;
        this.initializer = initializer || null;
    }
};

caffe2.Node = class {

    constructor(metadata, op, values) {
        this.name = op.name || '';
        this.device = op.engine || '';
        this.chain = [];
        this.type = metadata.type(op.type);
        this.attributes = op.arg.map((arg) => {
            const schema = metadata.attribute(op.type, arg.name);
            const name = arg.name;
            let value = null;
            let type = null;
            let visible = true;
            if (arg.floats && arg.floats.length > 0) {
                value = arg.floats;
            } else if (arg.ints && arg.ints.length > 0) {
                value = arg.ints;
            } else if (arg.nets && arg.nets.length > 0) {
                value = arg.nets.map((net) => new caffe2.Graph(metadata, net, null));
                type = 'graph[]';
            } else if (arg.n) {
                value = new caffe2.Graph(metadata, arg.n, null);
                type = 'graph';
            } else {
                value = arg.i;
            }
            if (schema) {
                type = !type && schema.type ? schema.type : type;
                if (type === 'boolean') {
                    value = value !== 0 && value.toString() !== '0' ? true : false;
                }
                if (schema.visible === false) {
                    visible = false;
                } else if (schema.default !== undefined) {
                    if (value === metadata.default || (value && value.toString() === schema.default.toString())) {
                        visible = false;
                    }
                }
            }
            return new caffe2.Argument(name, value, type, visible);
        });
        const inputs = op.input;
        const outputs = op.output;
        this.inputs = [];
        let inputIndex = 0;
        if (this.type && this.type.inputs) {
            for (const inputDef of this.type.inputs) {
                if (inputIndex < inputs.length || inputDef.option !== 'optional') {
                    const inputCount = (inputDef.option === 'variadic') ? (inputs.length - inputIndex) : 1;
                    const inputArguments = inputs.slice(inputIndex, inputIndex + inputCount).filter((id) => id !== '' || inputDef.option !== 'optional').map((id) => values.map(id));
                    this.inputs.push(new caffe2.Argument(inputDef.name, inputArguments));
                    inputIndex += inputCount;
                }
            }
        } else {
            this.inputs.push(...inputs.slice(inputIndex).map((input, index) => {
                const inputName = ((inputIndex + index) === 0) ? 'input' : (inputIndex + index).toString();
                return new caffe2.Argument(inputName, [values.map(input)]);
            }));
        }
        this.outputs = [];
        let outputIndex = 0;
        if (this.type && this.type.outputs) {
            for (const outputDef of this.type.outputs) {
                if (outputIndex < outputs.length || outputDef.option !== 'optional') {
                    const outputCount = (outputDef.option === 'variadic') ? (outputs.length - outputIndex) : 1;
                    const outputArguments = outputs.slice(outputIndex, outputIndex + outputCount).map((id) => values.map(id));
                    this.outputs.push(new caffe2.Argument(outputDef.name, outputArguments));
                    outputIndex += outputCount;
                }
            }
        } else {
            this.outputs.push(...outputs.slice(outputIndex).map((output, index) => {
                const outputName = ((outputIndex + index) === 0) ? 'output' : (outputIndex + index).toString();
                return new caffe2.Argument(outputName, [values.map(output)]);
            }));
        }
    }
};

caffe2.Tensor = class {

    constructor(name, tensor) {
        this.name = name;
        const shape = tensor.shape && tensor.shape.ints ? tensor.shape.ints : null;
        this.type = new caffe2.TensorType(tensor.dataType, new caffe2.TensorShape(shape));
        this.values = null;
        this.category = 'Initializer';
        this.encoding = '|';
        if (tensor.Y_scale !== undefined || tensor.Y_zero_point !== undefined) {
            this.quantization = {
                type: 'linear',
                scale: [tensor.Y_scale ? tensor.Y_scale.f : 0],
                offset: [tensor.Y_zero_point && typeof tensor.Y_zero_point.i === 'bigint' ? tensor.Y_zero_point.i.toNumber() : 0]
            };
        }
        if (tensor.values) {
            switch (this.type.dataType) {
                case 'float32': this.values = tensor.values.floats; break;
                case 'boolean': this.values = tensor.values.ints; break;
                case 'int8': this.values = new Int8Array(tensor.values.s); break;
                case 'int32': this.values = tensor.values.ints; break;
                default: break;
            }
        }
    }
};

caffe2.TensorType = class {

    constructor(dataType, shape) {
        this.dataType = dataType || '?';
        this.shape = shape;
    }

    toString() {
        return this.dataType + this.shape.toString();
    }
};

caffe2.TensorShape = class {

    constructor(dimensions) {
        this.dimensions = Array.isArray(dimensions) ? dimensions.map((dim) => typeof dim === 'bigint' ? dim.toNumber() : dim) : dimensions;
    }

    toString() {
        if (Array.isArray(this.dimensions) && this.dimensions.length > 0) {
            return `[${this.dimensions.map((dim) => dim.toString()).join(',')}]`;
        }
        return '';
    }
};

caffe2.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading Caffe2 model.';
    }
};

export const ModelFactory = caffe2.ModelFactory;
