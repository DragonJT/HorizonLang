var code = `
X(a) { a - 6 }
Test(a, b) { X(a) * b }
Test(3, 5) + X(5)
`; 

function Tokenizer(code){
    function CreateLastToken(){
        if(split==false){
            tokens.push(code.substring(start, i));
        }
        split=true;
    }

    const operators = '{}+-*/(),<>';
    const whitespace = ' \t\n\r';
    var tokens = [];
    var split = true;
    var start = 0;
    for(var i=0;i<code.length;i++){
        var c = code[i];
        if(whitespace.includes(c)){
            CreateLastToken();
        }
        else if(operators.includes(c)){
            CreateLastToken();
            tokens.push(c);
        }
        else{
            if(split){
                split=false;
                start=i;
            }
        }
    }
    CreateLastToken();
    return tokens;
}

function SplitByComma(tokens){
    var start = 0;
    var values = [];
    for(var i=0;i<tokens.length;i++){
        if(typeof tokens[i] == 'string' && tokens[i] == ','){
            values.push(tokens.slice(start, i));
            start=i+1;
        }
    }
    var last = tokens.slice(start);
    if(last.length>0){
        values.push(last);
    }
    return values;
}

class Parameter{
    constructor(id, name){
        this.id = id;
        this.name = name;
    }
}

class Func{
    constructor(_export, name, parameters, body){
        this.isFunc = true;
        this.export = _export;
        this.name = name;
        this.parameters = parameters;
        this.body = body;
    }

    ToWasm(){
        var last = this.body[this.body.length-1];
        if(last.isExpression){
            var wasmParamters = this.parameters.map(p=>Valtype.f32);
            return WasmFunc(this.export, [Valtype.f32], this.name, wasmParamters, [], last.GetCodeBytes(this.parameters));
        }
        else{
            throw 'Expecting expression as return: '+JSON.stringify(last);
        }
    }
}

class Expression{
    constructor(tokens){
        this.isExpression = true;
        this.tokens = tokens;
    }

    GetCodeBytes(parameters){
        const operatorsToWasm = {
            '+':'add',
            '-':'sub',
            '/':'div',
            '*':'mul',
        }
        const operatorGroups = [['+', '-'], ['*', '/']];

        function EmitExpression(tokens){
            function IsDigit(c){
                return c>='0' && c<='9';
            }
    
            function TrySplit(operators){
                for(var i=tokens.length-1;i>=0;i--){
                    var t = tokens[i];
                    if(operators.includes(t)){
                        var left = EmitExpression(tokens.slice(0, i));
                        var right = EmitExpression(tokens.slice(i+1));
                        return [...left, ...right, Opcode['f32_'+operatorsToWasm[t]]];
                    }
                }
                return undefined;
            }
    
            function Call(name){
                var funcID = functions.findIndex(f=>f.name == name);
                if(funcID>=0){
                    return [Opcode.call, ...unsignedLEB128(funcID)];
                }
                else{
                    throw 'Cant find function or paramter: '+t;
                }
            }

            function GetArgs(tokens){
                var argExpressions = SplitByComma(tokens);
                var output = [];
                for(var a of argExpressions){
                    output.push(...EmitExpression(a));
                }
                return output;
            }

            if(tokens.length == 1){
                var t = tokens[0];
                if(typeof t == 'string'){
                    if(IsDigit(t[0])){
                        return [Opcode.f32_const, ...ieee754(parseFloat(t))];
                    }
                    else{
                        var parameter = parameters.find(p=>p.name == t);
                        if(parameter){
                            return [Opcode.get_local, ...unsignedLEB128(parameter.id)];
                        }
                        else{
                            return Call(t);
                        }
                    }
                }
                else{
                    throw 'Unexpected token: '+JSON.stringify(t);
                }
            }
            else if(tokens.length == 2){
                var t1 = tokens[0];
                var t2 = tokens[1];
                if(typeof t1 == 'string' && !IsDigit(t1) && typeof t2 == 'object' && t2.braces == '()'){
                    return [...GetArgs(t2.value), ...Call(t1)];
                }
            }
            else{
                for(var operators of operatorGroups){
                    var output = TrySplit(operators);
                    if(output){
                        return output;
                    }
                }
            }
            throw "Unexpected expression:"+JSON.stringify(tokens);
        }
        return [...EmitExpression(this.tokens), Opcode.end];
        
    }
    
}

function Parse(tokens){
    
    function ParseBraces(tokens){
        const braces = ['()', '{}', '[]'];    
        var i = 0;
        function ParseBraces(brace){
            var result = [];
            var start = i;
            for(;i<tokens.length;i++){
                var open = braces.find(b=>b[0] == tokens[i]);
                var close = braces.find(b=>b[1] == tokens[i]);
                if(open){
                    i++;
                    result.push({braces:open, value:ParseBraces(open)});
                }
                else if(close){
                    if(close == brace){
                        return result;
                    }
                }
                else{
                    result.push(tokens[i]);
                }
            }
            if(start==0){
                return result;
            }
            else{
                throw "Missing closing brace: "+brace+start;
            }
        }
        return ParseBraces(tokens, 0);
    }

    function ParseGroups(tokens){
        var start = 0;
        var groups = [];
        for(var i=0;i<tokens.length;i++){
            if(typeof tokens[i] == 'object' && tokens[i].braces == '{}'){
                tokens[i].value = ParseGroups(tokens[i].value);
                groups.push(tokens.slice(start, i+1));
                start = i+1;
            }
        }
        if(start < tokens.length){
            groups.push(tokens.slice(start, tokens.length));
        }
        return groups;
    }
    
    var groupedTokens = ParseGroups(ParseBraces(tokens));

    function ParseParameters(tokens){
        var splitTokens = SplitByComma(tokens);
        var parameters = [];
        var id = 0;
        for(var t of splitTokens){
            if(t.length == 1 && typeof t[0] == 'string'){
                parameters.push(new Parameter(id, t[0]));
                id++;
            }
            else{
                throw 'invalid parameter: '+JSON.stringify(t);
            }
        }
        return parameters;
    }

    function ParseTree(groupedTokens){
        var tree = [];
        for(var i=0;i<groupedTokens.length;i++){
            var group = groupedTokens[i];
            var lastGroup = group[group.length-1];
            if(typeof(lastGroup) == 'object' && lastGroup.braces == '{}'){
                var _export = false;
                var parameters = [];
                var name;
                var ii = 0;
                if(typeof(group[ii]) == 'string' && group[ii] == 'export'){
                    _export = true;
                    ii++;
                }
                if(typeof(group[ii]) == 'string'){
                    name = group[ii];
                    ii++;
                }
                if(typeof(group[ii]) == 'object' && group[ii].braces == '()'){
                    parameters = ParseParameters(group[ii].value);
                    ii++;
                }
                if(ii == group.length-1){
                    var body = ParseTree(lastGroup.value);
                    tree.push(new Func(_export, name, parameters, body));
                }
                else{
                    throw 'Too many tokens in function header';
                }
            }
            else{
                tree.push(new Expression(group));
            }
        } 
        return tree;
    }
    return ParseTree(groupedTokens);
}

var tree = Parse(Tokenizer(code));

var functions = [];
function FindFunctions(tree){
    for(var f of tree){
        if(f.isFunc){
            functions.push(f);
            if(f.body){
                FindFunctions(f.body);
            }
        }
    }    
}
FindFunctions(tree);
functions.push(new Func(true, '__Init__', [], [tree[tree.length-1]]));

wasmFuncs = functions.map(f=>f.ToWasm());
var importObject = {env:{}};
importObject.env.memory = new WebAssembly.Memory({ initial: 10, maximum: 10 });

var wasmBytes = Wasm(wasmFuncs);
WebAssembly.instantiate(wasmBytes, importObject).then(
    (obj) => {
        console.log(obj.instance.exports.__Init__());
    }
);